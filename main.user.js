// ==UserScript==
// @name         KVT Arztsuche Psychologen – Sammler + Viewer + Auto-Runner + Status
// @namespace    https://example.local/
// @version      3.0.1
// @updateURL    https://raw.githubusercontent.com/kv-thuringen/kv-thuringen-greasmonkey-crawler/main/main.user.js
// @downloadURL  https://raw.githubusercontent.com/kv-thuringen/kv-thuringen-greasmonkey-crawler/main/main.user.js
// @description  Sammelt Details aus KVT-Arztsuche-Detailseiten (inkl. Mo–So-Zeitfenster, Leistungsangebote) in LocalStorage. Viewer mit Suche/Export/Filter (Jetzt Sprechzeit + Status). Auto-Runner auf Übersichtsseiten: ein Popup, alle Links nacheinander per Redirect, dann nächste Seite klicken.
// @match        https://www.kv-thueringen.de/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    "use strict";

    const LS_KEY = "psychologen_sammlung_v1";
    const AUTO_KEY = "psychologen_autorun_v1";

    // -------------------------
    // Helpers
    // -------------------------
    function norm(s) {
        return (s || "").replace(/\s+/g, " ").trim();
    }

    function esc(s) {
        return (s ?? "")
            .toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function normIdFromName(name) {
        return norm(name)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "_")
            .replace(/^_+|_+$/g, "");
    }

    function toast(msg) {
        const el = document.createElement("div");
        el.textContent = msg;
        el.style.cssText = `
      position:fixed; right:14px; bottom:14px; z-index:999999;
      background:#111; color:#fff; padding:10px 12px; border-radius:10px;
      font:13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      box-shadow:0 8px 24px rgba(0,0,0,.25); opacity:.95;
      max-width: 520px;
    `;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2600);
    }

    function loadDB() {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return { version: 1, createdAt: new Date().toISOString(), updatedAt: null, items: {} };
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") throw new Error("bad");
            if (!parsed.items || typeof parsed.items !== "object") parsed.items = {};
            if (!parsed.version) parsed.version = 1;
            return parsed;
        } catch {
            localStorage.setItem(LS_KEY + "_corrupt_backup_" + Date.now(), raw);
            return { version: 1, createdAt: new Date().toISOString(), updatedAt: null, items: {} };
        }
    }

    function saveDB(db) {
        db.updatedAt = new Date().toISOString();
        localStorage.setItem(LS_KEY, JSON.stringify(db));
    }

    function computeFingerprint(rec) {
        const s = [rec.name, rec.telefon, rec.anschrift].map(v => norm(v)).join("|");
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return "h" + h.toString(16);
    }

    // -------------------------
    // Page type
    // -------------------------
    function isDetailsPage() {
        return /\/arztsuche\/arztsuche-details/i.test(location.pathname);
    }

    function isListPage() {
        // Übersicht: /arztsuche (dein Template)
        return /\/arztsuche\/?$/i.test(location.pathname) || /\/arztsuche\/liste\/?$/i.test(location.pathname);
    }

    // -------------------------
    // Collector (Details page)
    // -------------------------
    function findHeading(tag, headingText) {
        const nodes = Array.from(document.querySelectorAll(tag));
        const target = headingText.toLowerCase();
        return nodes.find(n => norm(n.textContent).toLowerCase() === target) || null;
    }

    function extractName() {
        const h1 = document.querySelector(".resultdetail h1, h1");
        return h1 ? norm(h1.textContent) : null;
    }

    function extractTelefon() {
        const h = findHeading("h3", "Telefon");
        if (!h) return null;
        const p =
              (h.nextElementSibling && h.nextElementSibling.tagName === "P" ? h.nextElementSibling : null) ||
              h.parentElement?.querySelector("p");
        return p ? norm(p.textContent) : null;
    }

    function extractFachgebiet() {
        const ps = Array.from(document.querySelectorAll(".resultdetail p"));
        const p = ps.find(x => norm(x.textContent).toLowerCase().startsWith("fachgebiet:"));
        if (!p) return null;
        return norm(p.textContent.replace(/^Fachgebiet:\s*/i, ""));
    }

    function extractEinrichtungUndAdresse() {
        const h = findHeading("h3", "Einrichtung");
        if (!h) return { einrichtung: null, anschrift: null, plzOrt: null, strasse: null };

        const p = h.nextElementSibling && h.nextElementSibling.tagName === "P" ? h.nextElementSibling : null;
        if (!p) return { einrichtung: null, anschrift: null, plzOrt: null, strasse: null };

        const lines = p.innerText.split("\n").map(norm).filter(Boolean);
        const einrichtung = lines[0] || null;
        const strasse = lines[1] || null;
        const plzOrt = lines[2] || null;
        const anschrift = [strasse, plzOrt].filter(Boolean).join(", ") || null;

        return { einrichtung, anschrift, plzOrt, strasse };
    }

    function extractLeistungsangebote() {
        // Fall A: <h3>Leistungsangebote</h3> + <ul>...
        const h3 = findHeading("h3", "Leistungsangebote");
        if (h3) {
            const ul = (h3.nextElementSibling && h3.nextElementSibling.tagName === "UL")
            ? h3.nextElementSibling
            : h3.parentElement?.querySelector("ul");
            if (ul) {
                return Array.from(ul.querySelectorAll("li")).map(li => norm(li.textContent)).filter(Boolean);
            }
        }

        // Fall B (dein Upload): <p><b>Leistungsangebote:</b></p> + direkt folgendes <ul>...
        const ps = Array.from(document.querySelectorAll(".resultdetail p"));
        const markerP = ps.find(p => /leistungsangebote\s*:/i.test(norm(p.textContent)));
        if (markerP) {
            const ul = (markerP.nextElementSibling && markerP.nextElementSibling.tagName === "UL")
            ? markerP.nextElementSibling
            : markerP.parentElement?.querySelector("ul");
            if (ul) {
                return Array.from(ul.querySelectorAll("li")).map(li => norm(li.textContent)).filter(Boolean);
            }
        }

        return [];
    }


    // --- Sprechzeiten: 7 Spalten (Mo–So), jeweils Array von {from,to,hinweis}
    function emptySprechzeitenByDay() {
        return {
            sprechzeit_mo: [],
            sprechzeit_di: [],
            sprechzeit_mi: [],
            sprechzeit_do: [],
            sprechzeit_fr: [],
            sprechzeit_sa: [],
            sprechzeit_so: [],
        };
    }

    function dayKeyFromText(dayText) {
        const t = norm(dayText).toLowerCase();
        if (/^mo\b|montag/.test(t)) return "mo";
        if (/^di\b|dienstag/.test(t)) return "di";
        if (/^mi\b|mittwoch/.test(t)) return "mi";
        if (/^do\b|donnerstag/.test(t)) return "do";
        if (/^fr\b|freitag/.test(t)) return "fr";
        if (/^sa\b|samstag|sonnabend/.test(t)) return "sa";
        if (/^so\b|sonntag/.test(t)) return "so";
        return null;
    }

    function parseTimeRanges(uhrzeitText) {
        const s = norm(uhrzeitText).replace(/uhr/gi, "").replace(/[–—]/g, "-");
        if (!s) return [];

        const parts = s.split(/\s*(?:,|;|\/|\bund\b|\+)\s*/i).map(norm).filter(Boolean);
        const ranges = [];
        for (const p of parts) {
            const m = p.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
            if (m) {
                const from = m[1].padStart(5, "0");
                const to = m[2].padStart(5, "0");
                ranges.push({ from, to });
            }
        }
        return ranges;
    }

    function extractSprechzeitenByDay() {
        const res = emptySprechzeitenByDay();
        const h = findHeading("h3", "Sprechzeiten");
        if (!h) return res;

        const table = h.nextElementSibling && h.nextElementSibling.tagName === "TABLE" ? h.nextElementSibling : null;
        if (!table) return res;

        const rows = Array.from(table.querySelectorAll("tr"));
        for (const tr of rows) {
            const tds = Array.from(tr.querySelectorAll("td")).map(td => norm(td.textContent));
            if (!tds.length) continue;

            const tag = tds[0] || "";
            const uhrzeit = tds[1] || "";
            const hinweis = tds[2] || null;

            const dk = dayKeyFromText(tag);
            if (!dk) continue;

            const parsed = parseTimeRanges(uhrzeit);
            const key = "sprechzeit_" + dk;

            if (parsed.length) {
                for (const r of parsed) res[key].push({ from: r.from, to: r.to, hinweis: hinweis || null });
            } else if (uhrzeit || hinweis) {
                // nicht parsebar -> ablegen, aber nicht für "jetzt offen" werten
                res[key].push({ from: null, to: null, hinweis: [uhrzeit, hinweis].filter(Boolean).join(" | ") });
            }
        }

        return res;
    }

    function ensureRecordHasNewFields(rec) {
        // Migration/Kompat: wenn du alte Einträge hast
        if (!("leistungsangebote" in rec)) rec.leistungsangebote = [];
        if (!("status" in rec)) rec.status = null;
        if (!("statusUpdatedAt" in rec)) rec.statusUpdatedAt = null;

        const empty = emptySprechzeitenByDay();
        for (const k of Object.keys(empty)) {
            if (!(k in rec)) rec[k] = [];
        }
    }

    function collectFromDetailsPage() {
        const name = extractName();
        if (!name) {
            toast("Sammler: Kein Name (h1) gefunden – nichts gespeichert.");
            return;
        }

        const id = normIdFromName(name);
        const db = loadDB();

        if (db.items[id]) {
            // Migration auf neue Felder, ohne zu überschreiben
            ensureRecordHasNewFields(db.items[id]);
            saveDB(db);
            toast(`Sammler: Bereits vorhanden – übersprungen: ${name}`);
            return;
        }

        const telefon = extractTelefon();
        const fachgebiet = extractFachgebiet();
        const { einrichtung, anschrift, plzOrt, strasse } = extractEinrichtungUndAdresse();
        const sprech = extractSprechzeitenByDay();
        const leistungsangebote = extractLeistungsangebote();

        const rec = {
            id,
            name,
            fachgebiet,
            telefon,
            einrichtung,
            strasse,
            plzOrt,
            anschrift,

            leistungsangebote,

            // manuell gepflegt (Telefonat etc.)
            status: null,
            statusUpdatedAt: null,

            ...sprech,
            sourceUrl: location.href,
            scrapedAt: new Date().toISOString(),
        };

        rec.fingerprint = computeFingerprint(rec);

        db.items[id] = rec;
        saveDB(db);

        toast(`Sammler: Gespeichert: ${name} (gesamt: ${Object.keys(db.items).length})`);
    }

    // -------------------------
    // Manual status on details pages
    // -------------------------
    const STATUS_OPTIONS = [
        { code: "keine_neuen_patienten", label: "Keine neuen Patienten" },
        { code: "keine_videosprechstunde", label: "Keine Videosprechstunde" },
        { code: "urlaub", label: "Urlaub" },
        { code: "erstgespraech_in_person_nicht_barrierefrei", label: "Erstgespräch nur in Person, aber nicht behindertengerecht" },
        { code: "erstgespraech_in_person_barrierefrei", label: "Erstgespräch in Person ist behindertengerecht" },
        { code: "online_ohne_in_person_moeglich", label: "Online-Sprechstunde ohne In-Person-Gespräch möglich" },
    ];

    function upsertStatusForCurrentDetailsPage() {
        if (!isDetailsPage()) {
            toast("Status: Du bist nicht auf einer Detailseite.");
            return;
        }

        const name = extractName();
        if (!name) {
            toast("Status: Kein Name gefunden.");
            return;
        }

        const id = normIdFromName(name);
        const db = loadDB();
        const rec = db.items[id];

        if (!rec) {
            toast("Status: Eintrag ist noch nicht in der Sammlung (Seite einmal laden, dann speichern).");
            return;
        }

        ensureRecordHasNewFields(rec);

        const current = rec.status?.code
        ? (STATUS_OPTIONS.find(o => o.code === rec.status.code)?.label || rec.status.code)
        : "(kein Status)";

        const choice = prompt(
            "Therapeut-Status setzen:\n\n" +
            STATUS_OPTIONS.map((o, i) => `${i + 1}) ${o.label}`).join("\n") +
            `\n\nAktuell: ${current}\n\n` +
            "Zahl (1-4) eingeben. Leer = abbrechen. 0 = Status löschen."
        );

        if (choice == null || choice.trim() === "") return;

        const n = Number(choice.trim());
        if (n === 0) {
            rec.status = null;
            rec.statusUpdatedAt = new Date().toISOString();
            saveDB(db);
            toast("Status gelöscht.");
            return;
        }

        const opt = STATUS_OPTIONS[n - 1];
        if (!opt) {
            toast("Status: Ungültige Auswahl.");
            return;
        }

        const note = prompt("Optional: kurze Notiz (z.B. Datum/Uhrzeit, Name am Telefon). Leer = keine.") ?? "";
        rec.status = { code: opt.code, label: opt.label, note: note.trim() || null };
        rec.statusUpdatedAt = new Date().toISOString();
        saveDB(db);

        toast(`Status gespeichert: ${opt.label}`);
    }

    // -------------------------
    // Viewer + Filters (Now + Status)
    // -------------------------
    const DAY_KEYS_JS = ["so", "mo", "di", "mi", "do", "fr", "sa"]; // JS: 0=So ... 6=Sa

    function timeToMin(hhmm) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
        if (!m) return null;
        const hh = Number(m[1]);
        const mm = Number(m[2]);
        if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
        return hh * 60 + mm;
    }

    function isOpenNow(rec, now = new Date()) {
        const dk = DAY_KEYS_JS[now.getDay()];
        const key = "sprechzeit_" + dk;
        const windows = Array.isArray(rec[key]) ? rec[key] : [];
        if (!windows.length) return false;

        const curMin = now.getHours() * 60 + now.getMinutes();

        for (const w of windows) {
            if (!w || !w.from || !w.to) continue;
            const a = timeToMin(w.from);
            const b = timeToMin(w.to);
            if (a == null || b == null) continue;
            if (a <= curMin && curMin < b) return true;
        }
        return false;
    }

    function formatDayWindows(rec) {
        const order = [
            ["mo", "Mo"], ["di", "Di"], ["mi", "Mi"], ["do", "Do"], ["fr", "Fr"], ["sa", "Sa"], ["so", "So"]
        ];

        const chunks = [];
        for (const [k, label] of order) {
            const arr = Array.isArray(rec["sprechzeit_" + k]) ? rec["sprechzeit_" + k] : [];
            if (!arr.length) continue;

            const lines = arr.map(w => {
                if (w.from && w.to) return `${w.from}-${w.to}${w.hinweis ? ` (${w.hinweis})` : ""}`;
                return w.hinweis ? `${w.hinweis}` : "(unbekannt)";
            });

            chunks.push(`${label}: ${lines.join(" | ")}`);
        }
        return chunks.join("\n");
    }

    function formatLeistungsangebote(rec) {
        const arr = Array.isArray(rec.leistungsangebote) ? rec.leistungsangebote : [];
        if (!arr.length) return "";
        return arr.join(" | ");
    }

    function statusLabel(rec) {
        return rec.status?.label || "";
    }

    function statusCode(rec) {
        return rec.status?.code || "";
    }

    function toCSV(rows) {
        const cols = [
            "name", "telefon", "fachgebiet", "einrichtung", "strasse", "plzOrt", "anschrift",
            "leistungsangebote",
            "status_label", "status_note", "statusUpdatedAt",
            "sprechzeit_mo", "sprechzeit_di", "sprechzeit_mi", "sprechzeit_do", "sprechzeit_fr", "sprechzeit_sa", "sprechzeit_so",
            "sourceUrl", "scrapedAt"
        ];

        const csvEscape = (v) => {
            const s = (v ?? "").toString();
            const needs = /[",\n\r]/.test(s);
            const t = s.replace(/"/g, '""');
            return needs ? `"${t}"` : t;
        };

        const header = cols.join(",");
        const lines = rows.map(r => {
            ensureRecordHasNewFields(r);

            const rowObj = { ...r };
            rowObj.leistungsangebote = formatLeistungsangebote(r);
            rowObj.status_label = r.status?.label || "";
            rowObj.status_note = r.status?.note || "";

            for (const dk of ["mo", "di", "mi", "do", "fr", "sa", "so"]) {
                const key = "sprechzeit_" + dk;
                const arr = Array.isArray(r[key]) ? r[key] : [];
                rowObj[key] = arr.map(w => {
                    if (w.from && w.to) return `${w.from}-${w.to}${w.hinweis ? ` (${w.hinweis})` : ""}`;
                    return w.hinweis || "";
                }).join(" | ");
            }

            return cols.map(c => csvEscape(rowObj[c])).join(",");
        });

        return [header, ...lines].join("\n");
    }

    function download(filename, text) {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function openViewer() {
        const db = loadDB();
        const items = Object.values(db.items || {}).slice();
        items.forEach(ensureRecordHasNewFields);
        items.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

        let filterNow = false;
        let filterText = "";
        let filterStatus = "ALL"; // ALL | NONE | <status code>

        const overlay = document.createElement("div");
        overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(0,0,0,.35);
      display: flex; align-items: center; justify-content: center;
      padding: 18px;
    `;

        const modal = document.createElement("div");
        modal.style.cssText = `
      width: min(1280px, 98vw);
      height: min(820px, 92vh);
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 18px 60px rgba(0,0,0,.35);
      overflow: hidden;
      font: 14px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #111;
      display: flex; flex-direction: column;
    `;

        const statusOptionsHtml =
              `<option value="ALL">Status: alle</option>` +
              `<option value="ANY">Status: vorhanden</option>` +
              `<option value="NONE">Status: (kein Eintrag)</option>` +
              STATUS_OPTIONS.map(o => `<option value="${esc(o.code)}">${esc(o.label)}</option>`).join("");

        modal.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center; padding:12px 14px; border-bottom:1px solid #e8e8e8;">
        <div style="font-weight:700;">Psychologen-Sammlung</div>
        <div style="opacity:.7;" id="psCount"></div>
        <div style="flex:1;"></div>
        <input id="psSearch" placeholder="Suche (Name, Ort, Telefon, Fachgebiet, Angebote, Sprechzeiten, Status) …"
          style="width:min(520px, 50vw); padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px;">
        <button id="psClose" style="padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px; background:#fff; cursor:pointer;">Schließen</button>
      </div>

      <div style="display:flex; gap:10px; padding:10px 14px; border-bottom:1px solid #f0f0f0; flex-wrap:wrap; align-items:center;">
        <button id="psToggleNow" style="padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px; background:#fff; cursor:pointer;">
          Jetzt Sprechzeit: AUS
        </button>

        <select id="psStatusFilter" style="padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px; background:#fff;">
          ${statusOptionsHtml}
        </select>

        <button id="psExportJSON" style="padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px; background:#fff; cursor:pointer;">Export JSON</button>
        <button id="psExportCSV" style="padding:8px 10px; border:1px solid #d9d9d9; border-radius:10px; background:#fff; cursor:pointer;">Export CSV</button>
        <button id="psClear" style="padding:8px 10px; border:1px solid #ffcccc; border-radius:10px; background:#fff; cursor:pointer;">Alles löschen</button>

        <div id="psMsg" style="margin-left:auto; opacity:.75;"></div>
      </div>

      <div style="flex:1; overflow:auto;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="position:sticky; top:0; background:#fafafa; border-bottom:1px solid #eaeaea;">
              <th style="text-align:left; padding:10px 12px; width: 260px;">Name</th>
              <th style="text-align:left; padding:10px 12px; width: 160px;">Telefon</th>
              <th style="text-align:left; padding:10px 12px; width: 280px;">Anschrift</th>
              <th style="text-align:left; padding:10px 12px; width: 280px;">Leistungsangebote</th>
              <th style="text-align:left; padding:10px 12px; width: 260px;">Status</th>
              <th style="text-align:left; padding:10px 12px;">Sprechzeiten (Mo–So)</th>
              <th style="text-align:left; padding:10px 12px; width: 110px;">Jetzt</th>
              <th style="text-align:left; padding:10px 12px; width: 120px;">Link</th>
            </tr>
          </thead>
          <tbody id="psBody"></tbody>
        </table>
      </div>
    `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const $ = (sel) => modal.querySelector(sel);

        function updateItemFromDb(id, rec) {
            const idx = items.findIndex(r => r.id === id);
            if (idx === -1) return;
            const next = { ...rec };
            ensureRecordHasNewFields(next);
            items[idx] = next;
        }

        function refreshCounts() {
            const filtered = applyFilter(items);
            $("#psCount").textContent = `(${items.length} Einträge)`;
            $("#psMsg").textContent = (filterNow || filterText.trim() || filterStatus !== "ALL")
                ? `${filtered.length} Treffer`
                : "";
        }

        function updateRowUi(id, rec) {
            const row = modal.querySelector(`[data-ps-row="${CSS.escape(id)}"]`);
            if (!row) return;

            const noteEl = row.querySelector("[data-ps-note]");
            const metaEl = row.querySelector("[data-ps-meta]");

            if (noteEl) {
                noteEl.textContent = rec.status?.note || "";
                noteEl.style.display = rec.status?.note ? "block" : "none";
            }
            if (metaEl) {
                metaEl.textContent = rec.statusUpdatedAt
                    ? new Date(rec.statusUpdatedAt).toLocaleString()
                    : "";
                metaEl.style.display = rec.statusUpdatedAt ? "block" : "none";
            }

            const shouldShow = applyFilter([rec]).length > 0;
            row.style.display = shouldShow ? "" : "none";
            refreshCounts();
        }

        function applyFilter(arr) {
            const f = filterText.trim().toLowerCase();
            let out = arr;

            if (filterNow) out = out.filter(r => isOpenNow(r));

            if (filterStatus !== "ALL") {
                if (filterStatus === "ANY") {
                    out = out.filter(r => !!r.status);
                } else if (filterStatus === "NONE") {
                    out = out.filter(r => !r.status);
                } else {
                    out = out.filter(r => statusCode(r) === filterStatus);
                }
            }


            if (f) {
                out = out.filter(r => {
                    const hay = [
                        r.name, r.telefon, r.anschrift, r.plzOrt, r.strasse, r.fachgebiet, r.einrichtung,
                        formatLeistungsangebote(r),
                        statusLabel(r),
                        r.status?.note || "",
                        formatDayWindows(r)
                    ].join(" ").toLowerCase();
                    return hay.includes(f);
                });
            }

            return out;
        }

        function nowCell(rec) {
            return isOpenNow(rec) ? `<span style="font-weight:650;">JETZT</span>` : `<span style="opacity:.7;">—</span>`;
        }

        function render() {
            const filtered = applyFilter(items);

            $("#psCount").textContent = `(${items.length} Einträge)`;
            $("#psMsg").textContent = (filterNow || filterText.trim() || filterStatus !== "ALL")
                ? `${filtered.length} Treffer`
                : "";

            const body = $("#psBody");
            body.innerHTML = filtered.map(r => {
                const sprech = formatDayWindows(r);
                const link = r.sourceUrl ? `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noreferrer">öffnen</a>` : "";
                const stSelect = `
  <select data-ps-id="${esc(r.id)}"
          style="width:100%; padding:6px 8px; border:1px solid #d9d9d9; border-radius:10px; background:#fff;">
    <option value="">(kein Status)</option>
    ${STATUS_OPTIONS.map(o => `
      <option value="${esc(o.code)}" ${r.status?.code === o.code ? "selected" : ""}>
        ${esc(o.label)}
      </option>
    `).join("")}
  </select>
`;

              const stNote = r.status?.note || "";
              const stMeta = r.statusUpdatedAt ? new Date(r.statusUpdatedAt).toLocaleString() : "";
              const st = stSelect +
                `<div data-ps-note style="margin-top:6px; opacity:.8; font-size:12px; white-space:pre-wrap;${stNote ? "" : " display:none;"}">${esc(stNote)}</div>` +
                `<div data-ps-meta style="margin-top:4px; opacity:.55; font-size:12px;${stMeta ? "" : " display:none;"}">${esc(stMeta)}</div>`;


              return `
          <tr data-ps-row="${esc(r.id)}" style="border-bottom:1px solid #f2f2f2;">
            <td style="padding:10px 12px; vertical-align:top;">
              <div style="font-weight:650;">${esc(r.name || "")}</div>
              <div style="opacity:.75; font-size:12px;">${esc(r.fachgebiet || "")}</div>
              <div style="opacity:.55; font-size:12px;">${esc(r.einrichtung || "")}</div>
            </td>
            <td style="padding:10px 12px; vertical-align:top;">${esc(r.telefon || "")}</td>
            <td style="padding:10px 12px; vertical-align:top;">
              <div>${esc(r.strasse || "")}</div>
              <div style="opacity:.8;">${esc(r.plzOrt || "")}</div>
            </td>
            <td style="padding:10px 12px; vertical-align:top; white-space:pre-wrap;">${esc(formatLeistungsangebote(r))}</td>
            <td style="padding:10px 12px; vertical-align:top;">${st}</td>
            <td style="padding:10px 12px; vertical-align:top; white-space:pre-wrap;">${esc(sprech || "")}</td>
            <td style="padding:10px 12px; vertical-align:top;">${nowCell(r)}</td>
            <td style="padding:10px 12px; vertical-align:top;">${link}</td>
          </tr>
        `;
          }).join("");
        }

        // Status-Dropdown pro Zeile: Änderung sofort speichern
        $("#psBody").addEventListener("change", (e) => {
            const sel = e.target;
            if (!(sel instanceof HTMLSelectElement)) return;
            const id = sel.getAttribute("data-ps-id");
            if (!id) return;

            const code = sel.value || ""; // "" => löschen

            const dbNow = loadDB();
            const rec = dbNow.items?.[id];
            if (!rec) return;

            ensureRecordHasNewFields(rec);

            if (!code) {
                rec.status = null;
                rec.statusUpdatedAt = new Date().toISOString();
                saveDB(dbNow);
                updateItemFromDb(id, rec);
                updateRowUi(id, rec);
                return;
            }

            const opt = STATUS_OPTIONS.find(o => o.code === code);
            if (!opt) return;

            // Note bleibt erhalten, wenn vorhanden (du kannst das ändern, wenn du willst)
            const oldNote = rec.status?.note || null;

            rec.status = { code: opt.code, label: opt.label, note: oldNote };
            rec.statusUpdatedAt = new Date().toISOString();
            saveDB(dbNow);

            updateItemFromDb(id, rec);
            updateRowUi(id, rec);
        });


        $("#psClose").onclick = () => overlay.remove();
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

        $("#psSearch").addEventListener("input", (e) => {
            filterText = e.target.value || "";
            render();
        });

        $("#psToggleNow").onclick = () => {
            filterNow = !filterNow;
            $("#psToggleNow").textContent = `Jetzt Sprechzeit: ${filterNow ? "AN" : "AUS"}`;
            render();
        };

        $("#psStatusFilter").addEventListener("change", (e) => {
            filterStatus = e.target.value || "ALL";
            render();
        });

        $("#psExportJSON").onclick = () => {
            const dbNow = loadDB();
            download("psychologen_sammlung.json", JSON.stringify(dbNow, null, 2));
        };

        $("#psExportCSV").onclick = () => {
            const dbNow = loadDB();
            const rows = Object.values(dbNow.items || {});
            rows.forEach(ensureRecordHasNewFields);
            download("psychologen_sammlung.csv", toCSV(rows));
        };

        $("#psClear").onclick = () => {
            if (!confirm("Wirklich ALLE gespeicherten Einträge löschen?")) return;
            const empty = { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: {} };
            saveDB(empty);
            items.length = 0;
            filterText = "";
            filterNow = false;
            filterStatus = "ALL";
            $("#psSearch").value = "";
            $("#psStatusFilter").value = "ALL";
            $("#psToggleNow").textContent = "Jetzt Sprechzeit: AUS";
            render();
            $("#psMsg").textContent = "Gelöscht.";
            setTimeout(() => ($("#psMsg").textContent = ""), 1600);
        };

        render();
    }

    // -------------------------
    // Auto-Runner (List page): one popup, redirect through all details, then next page
    // -------------------------
    function autoLoadState() {
        try {
            return JSON.parse(sessionStorage.getItem(AUTO_KEY) || "null");
        } catch {
            return null;
        }
    }

    function autoSaveState(state) {
        sessionStorage.setItem(AUTO_KEY, JSON.stringify(state));
    }

    function autoClearState() {
        sessionStorage.removeItem(AUTO_KEY);
    }

    function getDetailLinksOnListPage() {
        const anchors = Array.from(document.querySelectorAll('a[href*="/arztsuche/arztsuche-details"]'));
        const seen = new Set();
        const urls = [];
        for (const a of anchors) {
            const href = a.href;
            if (!href) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            urls.push(href);
        }
        return urls;
    }

    function getPaginationInfo() {
        const form = document.querySelector("form.pagination");
        if (!form) return { form: null, pages: [], active: null };

        const btns = Array.from(form.querySelectorAll('input.pagination-button[type="submit"][name="tx_t3kvclient_showclient[page]"]'));
        const pages = btns
        .map(b => ({ el: b, n: Number(String(b.value).trim()), active: b.classList.contains("active") }))
        .filter(x => Number.isFinite(x.n))
        .sort((a, b) => a.n - b.n);

        const active = pages.find(p => p.active)?.n ?? null;
        return { form, pages, active };
    }

    function clickNextPageOrStop() {
        const { pages, active } = getPaginationInfo();
        if (!pages.length || !active) {
            toast("Auto: Keine Pagination gefunden – stop.");
            autoClearState();
            return;
        }

        const max = pages[pages.length - 1].n;
        if (active >= max) {
            toast("Auto: Letzte Seite erreicht – fertig.");
            autoClearState();
            return;
        }

        const next = pages.find(p => p.n === active + 1);
        if (!next) {
            toast("Auto: Nächste Seite nicht gefunden – stop.");
            autoClearState();
            return;
        }

        toast(`Auto: Klicke nächste Seite: ${active + 1}`);
        next.el.click();
    }

    let sharedPopup = null;

    function ensurePopup(initialUrl) {
        // Kein noopener/noreferrer, sonst kannst du das Fenster nicht zuverlässig steuern
        const features = "popup=yes,width=980,height=820,scrollbars=yes,resizable=yes";
        if (!sharedPopup || sharedPopup.closed) {
            sharedPopup = window.open(initialUrl || "about:blank", "kvt_psy_shared", features);
        }
        return sharedPopup;
    }

    function redirectPopupTo(url) {
        const p = ensurePopup(url);
        if (!p) return false;
        try {
            p.location.assign(url);
            p.focus();
            return true;
        } catch {
            return false;
        }
    }

    async function runListAutomationFromHere(state) {
        if (!isListPage()) {
            toast("Auto: Nicht auf Übersichtsseite (/arztsuche).");
            return;
        }

        const urls = getDetailLinksOnListPage();
        if (!urls.length) {
            toast("Auto: Keine Detail-Links gefunden.");
            return;
        }

        const s = state || {
            running: true,
            delayMs: 2500,          // Versatz zwischen Redirects
            afterPageWaitMs: 2500,  // Wartezeit nach dem letzten Redirect bevor "next page"
            idx: 0,
            totalOpened: 0,
            startedAt: new Date().toISOString(),
            lastListUrl: null,
        };

        s.running = true;
        s.lastListUrl = location.href;
        autoSaveState(s);

        for (; s.idx < urls.length; s.idx++) {
            if (!s.running) break;
            autoSaveState(s);

            const url = urls[s.idx];
            const ok = redirectPopupTo(url);
            if (!ok) {
                toast("Auto: Popup-Redirect fehlgeschlagen. Starte per Menü erneut (Popup/Blocker).");
                s.running = false;
                autoSaveState(s);
                return;
            }

            s.totalOpened++;
            autoSaveState(s);

            toast(`Auto: Redirect ${s.idx + 1}/${urls.length}`);
            await new Promise(r => setTimeout(r, s.delayMs));
        }

        if (s.running) {
            autoSaveState(s);
            await new Promise(r => setTimeout(r, s.afterPageWaitMs));
            clickNextPageOrStop();
        }
    }

    function startListAutomation() {
        if (!isListPage()) {
            toast("Auto: Starte auf der Übersichtsseite (/arztsuche).");
            return;
        }
        runListAutomationFromHere(null);
    }

    function stopListAutomation() {
        const s = autoLoadState();
        if (!s) {
            toast("Auto: Kein laufender Job.");
            return;
        }
        s.running = false;
        autoSaveState(s);
        toast("Auto: Stop gesetzt (wirkt nach dem aktuellen Delay).");
    }

    (function resumeIfNeeded() {
        if (!isListPage()) return;
        const s = autoLoadState();
        if (!s || !s.running) return;
        s.idx = 0;
        autoSaveState(s);
        setTimeout(() => runListAutomationFromHere(s), 800);
    })();

    // -------------------------
    // Menu commands
    // -------------------------
    GM_registerMenuCommand("Psychologen-Sammlung anzeigen", openViewer);
    GM_registerMenuCommand("Liste: Auto-Open & Next (Start)", startListAutomation);
    GM_registerMenuCommand("Liste: Auto-Open & Next (Stop)", stopListAutomation);

    GM_registerMenuCommand("Diese Detailseite einsammeln (jetzt)", () => {
        if (!isDetailsPage()) {
            toast("Sammler: Du bist nicht auf einer Detailseite (/arztsuche/arztsuche-details).");
            return;
        }
        collectFromDetailsPage();
    });

    GM_registerMenuCommand("Detail: Status nach Telefonat setzen", upsertStatusForCurrentDetailsPage);

    GM_registerMenuCommand("Sammlung zurücksetzen (löschen)", () => {
        if (!confirm("Wirklich ALLE gespeicherten Einträge löschen?")) return;
        saveDB({ version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: {} });
        toast("Sammlung gelöscht.");
    });

    // -------------------------
    // Auto-collect on details pages
    // -------------------------
    if (isDetailsPage()) collectFromDetailsPage();
})();

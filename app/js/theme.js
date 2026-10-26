// Darstellung: Auto (folgt dem System), Hell oder Dunkel. Die Wahl liegt pro Gerät im Browser (localStorage).
// Das Skript wird im <head> geladen, damit die Seite ohne Aufblitzen gleich im richtigen Modus erscheint.
(function () {
    const KEY = 'lit-theme';
    const ORDER = ['auto', 'light', 'dark'];
    const LABELS = { auto: '🖥️ Auto', light: '☀️ Hell', dark: '🌙 Dunkel' };
    const TITLES = {
        auto: 'Darstellung: Auto (folgt der Einstellung des Geräts). Klicken für Hell.',
        light: 'Darstellung: Hell. Klicken für Dunkel.',
        dark: 'Darstellung: Dunkel. Klicken für Auto.'
    };
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

    function stored() {
        try { const v = localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'auto'; } catch (e) { return 'auto'; }
    }

    function apply(pref) {
        const dark = pref === 'dark' || (pref === 'auto' && !!media && media.matches);
        const root = document.documentElement;
        root.dataset.theme = pref;
        root.dataset.scheme = dark ? 'dark' : 'light';
        document.querySelectorAll('.theme-toggle').forEach(btn => {
            btn.textContent = LABELS[pref];
            btn.title = TITLES[pref];
            btn.setAttribute('aria-label', TITLES[pref]);
        });
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#2563eb');
    }

    window.cycleTheme = function () {
        const next = ORDER[(ORDER.indexOf(stored()) + 1) % ORDER.length];
        try { localStorage.setItem(KEY, next); } catch (e) { /* ohne Speicher gilt die Wahl nur bis zum Neuladen */ }
        apply(next);
    };

    apply(stored());
    document.addEventListener('DOMContentLoaded', () => apply(stored()));
    if (media) {
        const onChange = () => { if (stored() === 'auto') apply('auto'); };
        if (media.addEventListener) media.addEventListener('change', onChange); else if (media.addListener) media.addListener(onChange);
    }
})();

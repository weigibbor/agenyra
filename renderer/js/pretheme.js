// Anti-flash theme set — runs synchronously in <head> BEFORE styles.css paints,
// so a light-theme user never sees a dark flash on boot. External (not inline)
// so the strict CSP (script-src 'self') allows it. Keep this tiny + dependency-free.
try { document.documentElement.dataset.theme = localStorage.getItem('am-theme') || 'dark'; } catch (e) {}

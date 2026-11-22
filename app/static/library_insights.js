document.querySelectorAll('.library-insights').forEach(section => {
    const buttons = section.querySelectorAll('[data-insights-scope]');
    const panels = section.querySelectorAll('[data-insights-panel]');
    buttons.forEach(button => button.addEventListener('click', () => {
        const scope = button.dataset.insightsScope;
        buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        panels.forEach(panel => { panel.hidden = panel.dataset.insightsPanel !== scope; });
    }));
});

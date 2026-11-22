(() => {
  function bounds(crop, width, height) {
    const clamp = value => Math.max(0, Math.min(1, value));
    const x = Math.floor(clamp(Math.min(crop.start.x, crop.end.x)) * width);
    const y = Math.floor(clamp(Math.min(crop.start.y, crop.end.y)) * height);
    const right = Math.ceil(clamp(Math.max(crop.start.x, crop.end.x)) * width);
    const bottom = Math.ceil(clamp(Math.max(crop.start.y, crop.end.y)) * height);
    if (right <= x || bottom <= y) throw new Error('Výrez je prázdny. Vyber oblasť znova.');
    return { x, y, width: right - x, height: bottom - y };
  }
  function wrap(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
      let line = '';
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
      lines.push(line);
    }
    return lines;
  }
  async function compose(dataUrl, crop, metadata) {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const area = bounds(crop, image.naturalWidth, image.naturalHeight);
    const scale = image.naturalWidth / metadata.viewport.width;
    const padding = Math.round(14 * scale);
    const lineHeight = Math.round(22 * scale);
    const width = Math.max(area.width, Math.round(320 * scale));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = `${Math.round(15 * scale)}px sans-serif`;
    ctx.font = font;
    const texts = [metadata.brief?.trim(), ...(metadata.actions || [])
      .filter(action => action.text).map(action => `${action.id}. ${action.text}`)].filter(Boolean);
    const lines = wrap(ctx, ['NEXUS · VÝREZ', metadata.url, ...texts].join('\n'), width - 2 * padding);
    canvas.width = width;
    canvas.height = area.height + 2 * padding + lines.length * lineHeight;
    ctx.fillStyle = '#171923';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => ctx.fillText(line, padding, area.height + padding + i * lineHeight));
    return canvas.toDataURL('image/png');
  }
  globalThis.NexusAnnotationExport = { bounds, wrap, compose };
})();

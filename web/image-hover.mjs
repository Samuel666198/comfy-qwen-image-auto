// Shared, noninteractive preview. Anchors are viewport rectangles, never canvas coordinates.
export function hoverPreviewPosition(anchor, width, height, viewportWidth, viewportHeight) {
  const margin = 8;
  const x = anchor.right + margin + width <= viewportWidth - margin
    ? anchor.right + margin : anchor.left - width - margin;
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(anchor.top, viewportHeight - height - margin)),
  };
}

export function createImageHoverPreview() {
  let panel = null, timer = null, generation = 0;
  function hide() {
    generation++; clearTimeout(timer); timer = null;
    panel?.remove(); panel = null;
  }
  function show(url, anchorRect, label = '') {
    hide(); if (!url) return;
    const token = generation;
    timer = setTimeout(() => {
      if (token !== generation) return;
      const current = document.createElement('div'); panel = current;
      current.className = 'qwen-image-hover';
      current.style.cssText = 'position:fixed;z-index:100050;pointer-events:none;padding:7px;border:1px solid #655a80;border-radius:9px;background:#202127;box-shadow:0 10px 28px #000a;box-sizing:border-box;';
      const img = document.createElement('img');
      img.alt = label;
      const maxWidth = Math.max(32, Math.min(320, window.innerWidth - 32));
      const maxHeight = Math.max(32, Math.min(400, window.innerHeight - 70));
      img.style.cssText = `display:block;max-width:${maxWidth}px;max-height:${maxHeight}px;object-fit:contain;border-radius:4px;`;
      const caption = document.createElement('div'); caption.textContent = label;
      caption.style.cssText = `max-width:${maxWidth}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cbc5d7;font:12px/20px sans-serif;`;
      const place = () => {
        if (panel !== current) return;
        const rect = current.getBoundingClientRect();
        const position = hoverPreviewPosition(anchorRect, rect.width, rect.height, window.innerWidth, window.innerHeight);
        current.style.left = `${position.left}px`; current.style.top = `${position.top}px`;
      };
      img.addEventListener('load', place);
      img.addEventListener('error', () => { if (panel === current) hide(); });
      current.append(img, caption); document.body.appendChild(current);
      img.src = url; place();
    }, 200);
  }
  return { show, hide, destroy: hide };
}

export function readableSnapshotPrompt(snapshot) {
  const refs = Array.isArray(snapshot?.refs) ? snapshot.refs : [];
  return String(snapshot?.prompt || "").replace(/\[\[qwen-ref:([^\]]+)\]\]/g, (_, id) => {
    const index = refs.findIndex(ref => ref.id === id);
    return index < 0 ? "@图片已删除" : `@图片${index + 1}`;
  });
}

export function mentionCandidates(refs, generated, query = "") {
  const search = String(query).toLowerCase();
  const current = refs.map((ref, index) => ({ ...ref, mentionLabel: `图片${index + 1} · ${ref.name || "参考图"}`, mentionGroup: "当前参考图" }));
  const works = generated.map(ref => ({ ...ref, mentionLabel: ref.label || ref.name || "已生成图片", mentionGroup: "已生成作品", generated: true }));
  return [...current, ...works].filter(ref => ref.mentionLabel.toLowerCase().includes(search));
}

export function resolveMentionReference(candidate, addGenerated) {
  if (!candidate?.generated) return candidate;
  try {
    const ref = addGenerated?.(candidate);
    return ref && typeof ref.id === "string" && !ref.then ? ref : null;
  } catch { return null; }
}

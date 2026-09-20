export function inspect(graph, query) {
  const needle = String(query || '').toLowerCase();
  const node = graph.nodes.find((n) => n.id === query) || graph.nodes.find((n) => n.name?.toLowerCase() === needle);
  if (!node) return null;
  const incoming = graph.edges.filter((e) => e.to === node.id);
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  return { node, incoming, outgoing, impact: impact(graph, node.id) };
}

export function search(graph, query, { kind, limit = 100 } = {}) {
  const needle = String(query || '').toLowerCase();
  return graph.nodes.filter((node) => (!kind || node.kind === kind) && (!needle || `${node.name} ${node.path} ${node.description || ''} ${node.id}`.toLowerCase().includes(needle))).slice(0, limit);
}

export function impact(graph, id, { depth = 3 } = {}) {
  const seen = new Set([id]);
  const levels = [];
  let frontier = [id];
  for (let i = 0; i < depth && frontier.length; i++) {
    const next = [];
    const links = graph.edges.filter((edge) => frontier.includes(edge.to) && !seen.has(edge.from));
    for (const edge of links) {
      if (!seen.has(edge.from)) { seen.add(edge.from); next.push(edge.from); }
    }
    if (next.length) levels.push(next);
    frontier = next;
  }
  return { count: seen.size - 1, levels };
}

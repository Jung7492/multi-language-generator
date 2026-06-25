const UI_WIDTH = 360;

figma.showUI(__html__, { width: UI_WIDTH, height: 520, themeColors: true });
figma.root.setRelaunchData({ '952afa79-637d-4917-bb98-d6e73a984a63': 'Multi-language Generator' });

// ─── Types ───────────────────────────────────────────────────────────────────

interface TextNodeInfo {
  id: string;
  name: string;
  text: string;
  path: string;
}

type Msg =
  | { type: 'scan' }
  | { type: 'locate'; nodeId: string }
  | { type: 'rename'; nodeId: string; newName: string }
  | { type: 'rename-batch'; renames: { nodeId: string; newName: string }[] }
  | { type: 'generate'; languages: string[]; translations: Record<string, Record<string, string>>; checkedNodeNames: string[] }
  | { type: 'resize'; height: number };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function scanTextNodes(node: SceneNode, pathParts: string[] = []): Promise<TextNodeInfo[]> {
  const results: TextNodeInfo[] = [];
  const currentPath = [...pathParts, node.name];

  if (node.type === 'TEXT') {
    results.push({
      id: node.id,
      name: node.name,
      text: node.characters,
      path: pathParts.join(' › '),
    });
  }

  if ('children' in node) {
    for (const child of node.children) {
      results.push(...(await scanTextNodes(child as SceneNode, currentPath)));
    }
  }

  return results;
}

async function loadAllFonts(node: TextNode): Promise<void> {
  if (node.characters.length === 0) return;
  const fontSet = new Set<string>();

  if (typeof node.fontName !== 'symbol') {
    fontSet.add(JSON.stringify(node.fontName));
  }

  for (let i = 0; i < node.characters.length; i++) {
    const f = node.getRangeFontName(i, i + 1);
    if (typeof f !== 'symbol') {
      fontSet.add(JSON.stringify(f));
    }
  }

  await Promise.all([...fontSet].map((f) => figma.loadFontAsync(JSON.parse(f) as FontName)));
}

async function applyTranslations(
  node: SceneNode,
  translations: Record<string, string>,
  checkedNodeNames: Set<string>
): Promise<void> {
  if (node.type === 'TEXT') {
    const nameLower = node.name.toLowerCase();
    const isChecked = [...checkedNodeNames].some(n => n.toLowerCase() === nameLower);
    if (isChecked) {
      const matchKey = Object.keys(translations).find(k => k.toLowerCase() === nameLower);
      const translated = matchKey !== undefined ? translations[matchKey] : undefined;
      if (translated !== undefined && translated !== '') {
        try {
          await loadAllFonts(node);
          node.characters = translated;
        } catch (e) {
          console.warn(`Could not replace text for node "${node.name}":`, e);
        }
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) {
      await applyTranslations(child as SceneNode, translations, checkedNodeNames);
    }
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: Msg) => {
  if (msg.type === 'resize') {
    figma.ui.resize(UI_WIDTH, Math.max(200, Math.min(900, Math.round(msg.height))));
    return;
  }

  if (msg.type === 'locate') {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (node && 'absoluteBoundingBox' in node) {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
    return;
  }

  if (msg.type === 'rename') {
    const node = await figma.getNodeByIdAsync(msg.nodeId);
    if (node) node.name = msg.newName;
    return;
  }

  if (msg.type === 'rename-batch') {
    for (const { nodeId, newName } of msg.renames) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (node) node.name = newName;
    }
    return;
  }

  if (msg.type === 'scan') {
    const rawSelection = figma.currentPage.selection;
    if (rawSelection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: '请先选中一个或多个Frame，然后再扫描。' });
      return;
    }
    const selection = [...rawSelection].sort((a, b) => {
      const ab = (a as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
      const bb = (b as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
      if (!ab || !bb) return 0;
      if (Math.abs(ab.y - bb.y) > 50) return ab.y - bb.y;
      return ab.x - bb.x;
    });
    const frameGroups: { frameName: string; frameId: string; nodes: TextNodeInfo[] }[] = [];
    for (const target of selection) {
      const nodes = await scanTextNodes(target);
      frameGroups.push({ frameName: target.name, frameId: target.id, nodes });
    }
    figma.ui.postMessage({ type: 'scan-result', frameGroups });
    return;
  }

  if (msg.type === 'generate') {
    const { languages, translations, checkedNodeNames } = msg;
    const checkedSet = new Set(checkedNodeNames);
    const rawSelection = figma.currentPage.selection;
    if (rawSelection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: '请先选中一个或多个Frame。' });
      return;
    }
    const selection = [...rawSelection].sort((a, b) => {
      const ab = (a as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
      const bb = (b as SceneNode & { absoluteBoundingBox: Rect | null }).absoluteBoundingBox;
      if (!ab || !bb) return 0;
      if (Math.abs(ab.y - bb.y) > 50) return ab.y - bb.y;
      return ab.x - bb.x;
    });

    let srcMinX = Infinity, srcMinY = Infinity, srcMaxX = -Infinity, srcMaxY = -Infinity;
    for (const source of selection) {
      const s = source as LayoutMixin;
      srcMinX = Math.min(srcMinX, s.x);
      srcMinY = Math.min(srcMinY, s.y);
      srcMaxX = Math.max(srcMaxX, s.x + s.width);
      srcMaxY = Math.max(srcMaxY, s.y + s.height);
    }

    const PADDING = 40;
    const GAP = 200;
    const sectionW = (srcMaxX - srcMinX) + PADDING * 2;
    const sectionH = (srcMaxY - srcMinY) + PADDING * 2;
    let nextY = srcMaxY + GAP;
    const generatedNodes: SceneNode[] = [];

    for (let i = 0; i < languages.length; i++) {
      const lang = languages[i];
      figma.ui.postMessage({ type: 'progress', message: `正在生成 ${lang}（${i + 1}/${languages.length}）…` });

      const section = figma.createSection();
      section.name = lang;
      section.resizeWithoutConstraints(sectionW, sectionH);
      figma.currentPage.appendChild(section);
      section.x = srcMinX;
      section.y = nextY;

      for (const source of selection) {
        const s = source as LayoutMixin;
        const clone = source.clone();
        clone.name = `${source.name} [${lang}]`;
        await applyTranslations(clone, translations[lang] ?? {}, checkedSet);
        section.appendChild(clone);
        (clone as LayoutMixin).x = s.x - srcMinX + PADDING;
        (clone as LayoutMixin).y = s.y - srcMinY + PADDING;
        generatedNodes.push(clone);
      }

      nextY += sectionH + GAP;
    }

    figma.currentPage.selection = generatedNodes;
    figma.viewport.scrollAndZoomIntoView(generatedNodes);
    figma.ui.postMessage({ type: 'generate-done', count: languages.length });
  }
};
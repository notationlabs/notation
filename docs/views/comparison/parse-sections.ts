import type { ComarkTree, ComarkNode, ComarkElement } from "@notation/docs/ui/content";

export type ComparisonSections = Record<string, ComarkNode[]>;

function isElement(node: ComarkNode): node is ComarkElement {
  return Array.isArray(node) && typeof node[0] === "string";
}

function getTextContent(node: ComarkElement): string {
  return node
    .slice(2)
    .map((child) => (typeof child === "string" ? child : ""))
    .join("");
}

export function parseSections(tree: ComarkTree): ComparisonSections {
  const sections: ComparisonSections = {};
  let currentHeader = "";

  for (const node of tree.nodes) {
    if (isElement(node) && node[0] === "h3") {
      const text = getTextContent(node).toLowerCase().trim();
      if (text) {
        currentHeader = text;
        sections[currentHeader] = [];
      }
    } else if (currentHeader) {
      sections[currentHeader].push(node);
    }
  }

  return sections;
}

export function createTree(tree: ComarkTree, nodes: ComarkNode[]): ComarkTree {
  return { nodes, frontmatter: tree.frontmatter, meta: tree.meta };
}

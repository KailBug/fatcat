/** Locally bundled Lucide SVG symbols; licenses ship alongside the sprite. */
export type IconName = "plus" | "arrow-up-right" | "panel-left" | "folder" | "search" | "list-checks" | "compass" | "arrow-up" | "square" | "x" | "chevron-down" | "check" | "shield" | "pencil" | "list" | "info" | "git-branch" | "trash" | "ellipsis";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

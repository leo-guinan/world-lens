export type Box = [number, number, number, number];
export interface TextBlock { kind: "heading" | "text"; text: string; locator: string; box: Box | null; inView: boolean; drawn: boolean }
export interface Viewport { width: number; height: number; deviceScaleFactor: number }
export function extractVisibleBlocks(options?: { maxBlocks?: number; maxChars?: number }): {
  viewport: Viewport; blocks: TextBlock[]; canvases: Array<{ locator: string; box: Box }>;
};

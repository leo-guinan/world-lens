import type { Box } from "./extract-blocks.js";
export declare const PACK_SCHEMA: "world-lens.evidence-pack.v1";
export interface Placement { screen: string; box: Box; by: "capture" | "editor" }
export interface EvidenceItem { id: string; text: string; kind?: string; locator?: string; at?: Placement[]; [k: string]: unknown }
export interface Screen { id: string; file: string; sha256: string; width?: number; height?: number; label?: string }
export interface Derivative { of: string; file: string; sha256: string; note?: string }
export interface EvidencePack {
  schema: typeof PACK_SCHEMA; source: Record<string, unknown>; screens: Screen[]; items: EvidenceItem[]; derivatives?: Derivative[];
  snapshotHash: string; pageContentIsUntrusted: true; actionAuthorized: false; mutations: []; interpretation: null; [k: string]: unknown;
}
export type UnsealedPack = Omit<EvidencePack, "schema" | "snapshotHash" | "pageContentIsUntrusted" | "actionAuthorized" | "mutations" | "interpretation"> & { schema?: typeof PACK_SCHEMA };
export function canonicalPack(pack: Pick<EvidencePack, "schema" | "source" | "items" | "screens">): string;
export function sha256Hex(data: string | Uint8Array): Promise<string>;
export function hashPack(pack: Pick<EvidencePack, "schema" | "source" | "items" | "screens">): Promise<string>;
export function sealPack(pack: UnsealedPack): Promise<EvidencePack>;
export function verifyPack(pack: EvidencePack, options?: { read?: (file: string) => Promise<Uint8Array | null>; allowMissingScreens?: boolean }): Promise<{ ok: boolean; errors: string[]; warnings: string[]; checked: { items: number; screens: number; derivatives: number } }>;
export function evidenceIn(pack: EvidencePack, id: string, screen?: string): { id: string; text: string; kind?: string; screen: string | null; box: Box | null; by: "capture" | "editor" | null } | null;
export function normalizeQuote(s: string): string;
export function supports(pack: EvidencePack, cite: string | null | undefined, quote?: string | null, options?: { illustrative?: boolean }): string | null;
export function findSupport(pack: EvidencePack, quote: string): string | null;
export function packFromReceipt(receipt: { id: string; finalUrl: string; requestedUrl: string; status: number | null; snapshotHash: string; actionsPerformed?: string[]; screenshotHash?: string; viewport?: { width: number; height: number; deviceScaleFactor: number } | null; observations?: Array<{ evidenceId: string; kind: string; value: string; locator: string; box?: Box | null; drawn?: boolean }> }, options?: { screenshotFile?: string; screenshotSha256?: string }): Promise<EvidencePack>;

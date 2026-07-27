import type { DocCategory } from "@notation/docs/config";
import { manual } from "./manual/nav";
import { cli } from "./cli/nav";
import { resources } from "./resources/nav";
import { internals } from "./internals/nav";

// Each category declares its own nav in a `nav.ts` beside its Markdown. This
// file only fixes the order they appear in, which must match the `categories`
// option in vite.config.ts.
export const categories: DocCategory[] = [manual, cli, resources, internals];

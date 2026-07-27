import type { DocCategory } from "@notation/docs/config";

export const internals: DocCategory = {
  label: "Internals",
  slug: "internals",
  sections: [
    {
      heading: "Architecture",
      icon: "layers",
      links: [
        { label: "Compiler", slug: "internals/compiler" },
        { label: "Reconciler", slug: "internals/reconciler" },
        { label: "Resource", slug: "internals/resource" },
        { label: "State", slug: "internals/state" },
      ],
    },
  ],
};

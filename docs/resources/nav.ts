import type { DocCategory } from "@notation/docs/config";

export const resources: DocCategory = {
  label: "Resources",
  slug: "resources",
  sections: [
    {
      heading: "AWS",
      icon: "cloud",
      links: [
        { label: "Lambda", slug: "resources/lambda" },
        { label: "API Gateway", slug: "resources/api-gateway" },
        { label: "EventBridge", slug: "resources/event-bridge" },
      ],
    },
  ],
};

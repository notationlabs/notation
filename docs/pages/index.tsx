import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@notation/docs/ui";
import { Hero } from "#/views/hero/hero";
import { Footer } from "#/views/shell/footer";

export const Route = createFileRoute("/")({
  component: () => (
    <div className="flex flex-col min-h-screen">
      <div className="flex-1">
        <SiteHeader />
        <Hero />
      </div>
      <Footer />
    </div>
  ),
});

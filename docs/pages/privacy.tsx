import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@notation/docs/ui";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader />
      <main className="flex-1 page-wrap py-12 md:py-16 max-w-3xl prose dark:prose-invert">
        <h1>Privacy Policy</h1>
        <p className="text-sm text-slate-500 dark:text-neutral-400">Last updated: June 6, 2026</p>
        <p className="mt-6">
          Your privacy is important to us. It is Notation's policy to respect your privacy regarding
          any information we may collect from you across our website, and other sites we own and
          operate.
        </p>

        <h2 className="mt-8 text-xl font-bold">1. Information We Collect</h2>
        <p className="mt-2">
          We only ask for personal information when we truly need it to provide a service to you. We
          collect it by fair and lawful means, with your knowledge and consent. We also let you know
          why we’re collecting it and how it will be used.
        </p>

        <h2 className="mt-8 text-xl font-bold">2. Retention of Information</h2>
        <p className="mt-2">
          We only retain collected information for as long as necessary to provide you with your
          requested service. What data we store, we’ll protect within commercially acceptable means
          to prevent loss and theft, as well as unauthorized access, disclosure, copying, use or
          modification.
        </p>

        <h2 className="mt-8 text-xl font-bold">3. Sharing of Information</h2>
        <p className="mt-2">
          We don't share any personally identifying information publicly or with third-parties,
          except when required to by law.
        </p>

        <h2 className="mt-8 text-xl font-bold">4. User Rights</h2>
        <p className="mt-2">
          You are free to refuse our request for your personal information, with the understanding
          that we may be unable to provide you with some of your desired services.
        </p>

        <h2 className="mt-8 text-xl font-bold">5. Consent</h2>
        <p className="mt-2">
          Your continued use of our website will be regarded as acceptance of our practices around
          privacy and personal information. If you have any questions about how we handle user data
          and personal information, feel free to contact us.
        </p>
      </main>
    </div>
  );
}

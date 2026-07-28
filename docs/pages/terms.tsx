import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@notation/docs/ui";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <SiteHeader />
      <main className="flex-1 page-wrap py-12 md:py-16 max-w-3xl prose dark:prose-invert">
        <h1>Terms of Service</h1>
        <p className="text-sm text-slate-500 dark:text-neutral-400">Last updated: June 6, 2026</p>
        <p className="mt-6">
          Welcome to Notation. By using our website and services, you agree to comply with and be
          bound by the following terms and conditions. Please review them carefully.
        </p>

        <h2 className="mt-8 text-xl font-bold">1. Acceptance of Terms</h2>
        <p className="mt-2">
          By accessing or using the website, you agree to be bound by these Terms of Service and all
          applicable laws and regulations. If you do not agree with any of these terms, you are
          prohibited from using or accessing this site.
        </p>

        <h2 className="mt-8 text-xl font-bold">2. Use License</h2>
        <p className="mt-2">
          Permission is granted to temporarily download one copy of the materials (information or
          software) on Notation's website for personal, non-commercial transitory viewing only.
        </p>

        <h2 className="mt-8 text-xl font-bold">3. Disclaimer</h2>
        <p className="mt-2">
          The materials on Notation's website are provided on an 'as is' basis. Notation makes no
          warranties, expressed or implied, and hereby disclaims and negates all other warranties
          including, without limitation, implied warranties or conditions of merchantability,
          fitness for a particular purpose, or non-infringement of intellectual property or other
          violation of rights.
        </p>

        <h2 className="mt-8 text-xl font-bold">4. Limitations of Liability</h2>
        <p className="mt-2">
          In no event shall Notation or its suppliers be liable for any damages (including, without
          limitation, damages for loss of data or profit, or due to business interruption) arising
          out of the use or inability to use the materials on Notation's website.
        </p>

        <h2 className="mt-8 text-xl font-bold">5. Governing Law</h2>
        <p className="mt-2">
          These terms and conditions are governed by and construed in accordance with the laws of
          Scotland and you irrevocably submit to the exclusive jurisdiction of the courts in that
          location.
        </p>
      </main>
    </div>
  );
}

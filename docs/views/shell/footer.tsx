import { Link } from "@tanstack/react-router";
import { NotationLogo } from "#/views/logo";

export function Footer() {
  return (
    <footer className="border-t border-line bg-slate-50/40 dark:bg-neutral-950/40 py-12 mt-auto w-full">
      <div className="page-wrap">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Link to="/" className="inline-block hover:opacity-85 transition-opacity">
                <NotationLogo />
              </Link>
            </div>
            <div className="text-xs text-slate-500 dark:text-neutral-400 space-y-2 max-w-sm">
              <p>
                Registered in Scotland. Company Number:{" "}
                <a
                  href="https://find-and-update.company-information.service.gov.uk/company/SC765604"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:text-accent underline transition-colors"
                >
                  SC765604
                </a>
              </p>
            </div>
          </div>
          <div className="flex flex-col md:items-end gap-6">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-slate-600 dark:text-neutral-300">
              <Link to="/docs" className="hover:text-accent transition-colors">
                Docs
              </Link>
              <Link to="/terms" className="hover:text-accent transition-colors">
                Terms of Service
              </Link>
              <Link to="/privacy" className="hover:text-accent transition-colors">
                Privacy Policy
              </Link>
            </div>
            <p className="text-xs text-slate-400 dark:text-neutral-500">
              &copy; {new Date().getFullYear()} Notation Labs Ltd. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

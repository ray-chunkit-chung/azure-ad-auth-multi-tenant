export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
      <section className="w-full rounded-2xl border border-sky-300/20 bg-slate-950/60 p-8 shadow-2xl shadow-black/40">
        <p className="text-xs uppercase tracking-[0.18em] text-sky-300">rcoauth2azure</p>
        <h1 className="mt-3 text-3xl font-semibold text-white">Azure AD Auth Project Scaffolded</h1>
        <p className="mt-4 text-sm leading-relaxed text-slate-200">
          Infrastructure and deployment pipelines are initialized for AWS hosting without Cognito or custom domains.
          The Azure AD login flow will be added once tenant and application details are available.
        </p>
        <div className="mt-6 rounded-xl border border-slate-700 bg-slate-900/70 p-4 text-sm text-slate-300">
          Current frontend deployment target uses CloudFront default domain from Terraform output.
        </div>
      </section>
    </main>
  );
}

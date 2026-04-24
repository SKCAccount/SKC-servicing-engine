import { createSupabaseServerClient, getCurrentAuthUser } from '@seaking/auth/server';
import { isManager } from '@seaking/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { UploadPoForm } from './upload-po-form';

interface PageProps {
  params: Promise<{ clientId: string }>;
}

export default async function NewPoUploadPage({ params }: PageProps) {
  const user = await getCurrentAuthUser();
  if (!user) redirect('/login');
  if (!isManager(user.role)) redirect('/login?reason=wrong_app');

  const { clientId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: clientRow } = await supabase
    .from('clients')
    .select('id, display_name')
    .eq('id', clientId)
    .maybeSingle();
  if (!clientRow) notFound();
  const client = clientRow as { id: string; display_name: string };

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <Link
          href={`/clients/${client.id}`}
          className="text-sm text-seaking-muted hover:text-seaking-ink hover:underline"
        >
          ← Back to {client.display_name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-seaking-navy">
          Purchase Order Upload
        </h1>
        <p className="mt-1 text-sm text-seaking-muted">
          Pick a retailer, choose a file, and review the summary before committing. The original
          file is retained indefinitely for audit.
        </p>
      </header>

      <div className="rounded-lg border border-seaking-border bg-seaking-surface p-6">
        <UploadPoForm clientId={client.id} />
      </div>

      <details className="mt-6 rounded border border-seaking-border bg-seaking-surface p-4">
        <summary className="cursor-pointer text-sm font-medium">What does each retailer expect?</summary>
        <div className="mt-3 space-y-2 text-xs text-seaking-muted">
          <p>
            <strong>Walmart</strong> — SupplierOne CSV export. Works for both the Header Level and
            Line Level variants; the parser auto-detects. Line Level is preferred (includes item
            descriptions and partial line cancellations).
          </p>
          <p>
            <strong>Kroger</strong> — not yet supported. Upload Kroger POs via the Generic
            template until we have a sample file to build the parser against.
          </p>
          <p>
            <strong>Generic CSV</strong> — use when Sea King does not yet have a dedicated parser
            for the retailer. Required columns: <code>PO Number</code>, <code>PO Value</code>.
            Other columns are optional.
          </p>
        </div>
      </details>
    </main>
  );
}

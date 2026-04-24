'use client';

/**
 * Inline "Page X of Y" with a jump-to input.
 *
 * Submitting the form (Enter or blur) navigates to the chosen page using
 * the same query string the page already had — only the `page` param is
 * overridden. Stays inside the URL-state model: no client cache, no fetch.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

interface Props {
  clientId: string;
  searchParams: Record<string, string>;
  currentPage: number;
  totalPages: number;
}

export function PageJumpInput({ clientId, searchParams, currentPage, totalPages }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(String(currentPage));

  // Keep the input in sync if the user navigates via prev/next without
  // re-rendering the component.
  useEffect(() => {
    setValue(String(currentPage));
  }, [currentPage]);

  function go(rawPage: number) {
    const target = Math.max(1, Math.min(totalPages, Math.floor(rawPage)));
    if (target === currentPage) return;
    const params = new URLSearchParams(searchParams);
    params.set('page', String(target));
    router.push(`/clients/${clientId}/purchase-orders?${params.toString()}`);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const n = Number(value);
    if (Number.isFinite(n)) go(n);
  }

  return (
    <form onSubmit={onSubmit} className="inline-flex items-center gap-1 px-1">
      <span className="text-xs text-seaking-muted">Page</span>
      <input
        type="number"
        min={1}
        max={totalPages}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const n = Number(value);
          if (Number.isFinite(n)) go(n);
        }}
        className="w-14 rounded border border-seaking-border bg-white px-2 py-1 text-center text-xs outline-none focus:border-seaking-navy"
        aria-label="Page number"
      />
      <span className="text-xs text-seaking-muted">of {totalPages.toLocaleString('en-US')}</span>
    </form>
  );
}

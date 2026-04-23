import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Conditional class composition with Tailwind-aware merging. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

import { Compass } from 'lucide-react';
import { Link } from 'wouter';

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <Compass className="mx-auto h-8 w-8 text-gray-400" />
        <h1 className="mt-4 text-2xl font-bold text-gray-900">
          This page doesn&apos;t exist
        </h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          The link may be old or mistyped. Nothing is wrong with your console —
          the overview page has everything you need.
        </p>
        <Link
          href="/"
          data-testid="link-not-found-home"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Back to the overview
        </Link>
      </div>
    </div>
  );
}

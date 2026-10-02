import { useEffect, useState } from 'react';
import { Camera, Download, Eye, Mic, Trash2, Video, X } from 'lucide-react';
import { casAuthedFetch, useFieldTest, type EvidenceItem } from '@/hooks/use-field-test';
import { formatEvidenceSize } from '@/hooks/use-capture-policy';
import { evidenceDownloadFilename } from '@/lib/evidence-download';
import { FriendlyErrorMessage } from '@/components/field-ui';

const KIND_ICONS = { audio: Mic, photo: Camera, video: Video } as const;

function capturedAgeLabel(capturedAt: string | null): string | null {
  if (!capturedAt) return null;
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(capturedAt)) / 1000));
  return ageSeconds < 90 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}min`;
}

/**
 * One evidence clip row, shared by the current alert's evidence panel and
 * the past-alert browser: inline view/play, download, and delete behind a
 * confirmation step.
 *
 * Viewing and downloading fetch the bytes with the console's Bearer
 * credential (a bare <img>/<audio> src cannot send it) and render through
 * an object URL. Delete rides the provider's deleteEvidence action, which
 * locks the whole console if the credential was revoked mid-session.
 *
 * testIdPrefix disambiguates the two panels: the same clip can render in
 * both (the latest incident is both the current alert and the default
 * browse selection), so the past-alert browser passes "browse-" to keep
 * every row's test ids unique on the page.
 */
export function EvidenceItemRow({ item, incidentId, onDeleted, testIdPrefix = '' }: {
  item: EvidenceItem;
  /** Owning incident — used for the download filename fallback and the delete confirmation. */
  incidentId: string;
  /** Called with the owning incident's id after the clip is deleted. */
  onDeleted: (incidentId: string) => void;
  /** Prepended to every data-testid so two panels never emit duplicates. */
  testIdPrefix?: string;
}) {
  const { deleteEvidence } = useFieldTest();
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Object URLs leak unless revoked; closing the viewer, replacing the URL,
  // and unmounting all revoke.
  useEffect(() => () => { if (viewUrl) URL.revokeObjectURL(viewUrl); }, [viewUrl]);

  const KindIcon = KIND_ICONS[item.kind];
  const capturedAge = capturedAgeLabel(item.capturedAt);

  const toggleView = async () => {
    if (viewUrl) { setViewUrl(null); return; }
    if (viewBusy) return;
    setViewBusy(true);
    setViewError(null);
    try {
      // The download route doubles as the byte source for inline viewing:
      // it is credentialed, and its attachment disposition only matters to
      // a real download, not to an in-memory blob.
      const response = await casAuthedFetch(`/api/cas/evidence/${item.id}/download`);
      if (!response.ok) throw new Error(`The clip could not be loaded (${response.status}).`);
      setViewUrl(URL.createObjectURL(await response.blob()));
    } catch (error) {
      setViewError(error instanceof Error ? error.message : 'The clip could not be loaded.');
    } finally {
      setViewBusy(false);
    }
  };

  const download = async () => {
    if (downloadBusy) return;
    setDownloadBusy(true);
    setDownloadError(null);
    try {
      const response = await casAuthedFetch(`/api/cas/evidence/${item.id}/download`);
      if (!response.ok) throw new Error(`Download was rejected (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The server's Content-Disposition filename is the source of truth
      // (it carries the camera label); the local fallback mirrors it.
      anchor.download = evidenceDownloadFilename(response.headers.get('content-disposition'), incidentId, item);
      // The anchor must be in the document: some browsers ignore synthetic
      // click() downloads on detached elements.
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The click only schedules the download — the browser starts reading
      // the blob asynchronously. Revoking the URL in the same tick races
      // that startup and silently aborts the download, so revoke only after
      // the download manager has had time to open the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      setDownloadBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteEvidence(item.id);
      onDeleted(incidentId);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Delete was rejected.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-[#e0e1da] bg-[#f7f7f1] px-3 py-2" data-testid={`${testIdPrefix}row-evidence-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <KindIcon size={14} className="text-[#203c49]" />
        <span className="text-xs font-bold text-[#203c49]">
          {item.kind}{item.camera ? ` · ${item.camera} camera` : ''}{item.sequence > 1 ? ` · clip ${item.sequence}` : ''}
        </span>
        <span className="text-[11px] text-[#687271]">
          {formatEvidenceSize(item.sizeBytes)}
          {capturedAge ? ` · captured ${capturedAge} ago` : ''}
          {item.requestId ? ' · requested by a responder' : ''}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <button
            onClick={() => { void toggleView(); }}
            disabled={viewBusy}
            className="inline-flex items-center gap-1 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#203c49] transition-colors hover:border-[#203c49] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`${testIdPrefix}button-view-evidence-${item.id}`}
          >
            {viewUrl ? <X size={12} /> : <Eye size={12} />} {viewBusy ? 'Loading…' : viewUrl ? 'Close' : item.kind === 'photo' ? 'View' : 'Play'}
          </button>
          <button
            onClick={() => { void download(); }}
            disabled={downloadBusy}
            className="inline-flex items-center gap-1 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#203c49] transition-colors hover:border-[#203c49] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`${testIdPrefix}button-download-evidence-${item.id}`}
          >
            <Download size={12} /> {downloadBusy ? 'Downloading…' : 'Download'}
          </button>
          <button
            onClick={() => { setConfirmingDelete(true); setDeleteError(null); }}
            disabled={confirmingDelete}
            className="inline-flex items-center gap-1 rounded-md border border-[#e7b8af] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#914136] transition-colors hover:bg-[#f8e0db] disabled:opacity-40"
            data-testid={`${testIdPrefix}button-delete-evidence-${item.id}`}
          >
            <Trash2 size={12} /> Delete
          </button>
        </span>
      </div>
      {(viewError || downloadError) && (
        <div className="mt-2" data-testid={`${testIdPrefix}text-evidence-error-${item.id}`}><FriendlyErrorMessage error={viewError ?? downloadError ?? ''} /></div>
      )}
      {viewUrl && (
        <div className="mt-2 rounded-lg border border-[#d7d8d0] bg-[#203c49] p-2" data-testid={`${testIdPrefix}viewer-evidence-${item.id}`}>
          {item.kind === 'photo' ? (
            <img src={viewUrl} alt={`${item.kind} evidence clip ${item.sequence}`} className="mx-auto max-h-80 rounded-md" />
          ) : item.kind === 'video' ? (
            <video src={viewUrl} controls className="mx-auto max-h-80 w-full rounded-md" />
          ) : (
            <audio src={viewUrl} controls className="w-full" />
          )}
        </div>
      )}
      {confirmingDelete && (
        <div className="mt-2 rounded-lg border border-[#e7b8af] bg-[#fbfbf7] p-3" data-testid={`${testIdPrefix}confirm-delete-evidence-${item.id}`}>
          <p className="text-[11px] font-bold leading-4 text-[#914136]">
            Delete this {item.kind} clip from alert <span className="font-mono-ui">{incidentId}</span> permanently?
          </p>
          <p className="mt-1 text-[11px] leading-4 text-[#687271]">
            The clip’s bytes are removed for good and it disappears from every list. The alert’s permanent record keeps a note that the clip existed and was deleted — history is never rewritten.
          </p>
          {deleteError && <div className="mt-2"><FriendlyErrorMessage error={deleteError} /></div>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={() => { void confirmDelete(); }}
              disabled={deleteBusy}
              className="rounded-md bg-[#914136] px-3 py-1.5 text-[11px] font-bold text-[#fbfbf7] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid={`${testIdPrefix}button-confirm-delete-evidence-${item.id}`}
            >
              {deleteBusy ? 'Deleting…' : 'Delete it permanently'}
            </button>
            <button
              onClick={() => { setConfirmingDelete(false); setDeleteError(null); }}
              disabled={deleteBusy}
              className="rounded-md border border-[#c6cbc3] px-3 py-1.5 text-[11px] font-bold text-[#687271] transition-colors hover:border-[#203c49] disabled:opacity-40"
              data-testid={`${testIdPrefix}button-cancel-delete-evidence-${item.id}`}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

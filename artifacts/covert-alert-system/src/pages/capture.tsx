import { useRef, useState } from 'react';
import { Camera, Check, Clock3, Eye, Mic, SwitchCamera, Video } from 'lucide-react';
import { FriendlyErrorMessage, SectionKicker } from '@/components/field-ui';
import {
  useCapturePolicy,
  type CaptureCamera,
  type CapturePolicy,
  type CaptureSetting,
  type CaptureTiming,
} from '@/hooks/use-capture-policy';

const KINDS = [
  {
    key: 'audio' as const,
    label: 'Audio',
    icon: Mic,
    detail: 'Rolling 30-second clips, up to 3 minutes per alert. The phone’s mic indicator shows in the status bar while recording.',
  },
  {
    key: 'photo' as const,
    label: 'Photo',
    icon: Camera,
    detail: 'One still per selected camera, with no camera screen opening. The camera indicator shows briefly.',
  },
  {
    key: 'video' as const,
    label: 'Video',
    icon: Video,
    detail: 'One 20-second clip per selected camera. The camera (and mic) indicators show while recording.',
  },
];

const SETTING_LABELS: Record<CaptureSetting, string> = {
  off: 'Off',
  trigger: 'Start when the alert triggers',
  responder: 'Only when a responder asks',
};

const TIMING_LABELS: Record<CaptureTiming, { label: string; detail: string }> = {
  immediate: {
    label: 'Right away',
    detail: 'Capture starts the moment the alert triggers — it catches the first ~60 seconds, while the screen is usually still on and the phone in someone’s hand.',
  },
  'screen-off': {
    label: 'When the screen next turns off',
    detail: 'Capture starts only once the screen goes dark after the trigger — the most discreet option. If the screen is already off, capture starts right away.',
  },
};

const CAMERA_LABELS: Record<CaptureCamera, { label: string; detail: string }> = {
  back: {
    label: 'Back camera',
    detail: 'The original behavior: photo and video record whatever the phone is pointed at.',
  },
  front: {
    label: 'Front camera',
    detail: 'Photo and video record whoever is holding the phone.',
  },
  both: {
    label: 'Front and back',
    detail: 'Records both angles — the surroundings and the holder. This needs newer hardware (Pixel 8 and later); on a phone without it, only the back camera records and the timeline notes the downgrade so it’s measured, not assumed.',
  },
};

/**
 * Evidence capture settings: per-type toggles and the start-timing mode,
 * applied by the handset on its next server contact — no app reinstall. The
 * owner runs the same scenario twice (immediate vs screen-off) and compares
 * the actual evidence and visibility of each.
 */
export default function Capture() {
  const { policy, loaded, saving, error, save, reload } = useCapturePolicy();
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The last policy the operator tried to save, so a failed PUT's "Try
  // again" resubmits that attempt instead of reloading (a GET) — a reload
  // would also leave this error showing after a successful fetch.
  const lastAttemptRef = useRef<CapturePolicy | null>(null);

  const submit = async (next: CapturePolicy) => {
    lastAttemptRef.current = next;
    setSaveError(null);
    try {
      await save(next);
      lastAttemptRef.current = null;
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2200);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'The capture policy could not be saved.');
    }
  };

  const apply = (changes: Partial<CapturePolicy>) => void submit({ ...policy, ...changes });

  const retrySave = () => {
    const next = lastAttemptRef.current;
    if (next) void submit(next);
  };

  return (
    <div className="mx-auto max-w-[980px]">
      <section className="fade-up border-b border-[#cfd2c9] pb-7">
        <div className="mb-4 flex items-center gap-3"><SectionKicker testId="kicker-evidence-capture-/-playground">Evidence capture</SectionKicker></div>
        <h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Choose what the phone records.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">
          Separate switches for audio, photo, and video. The phone picks up changes the next time it
          talks to the server — no reinstalling anything. Clips land on the alert’s evidence panel,
          downloadable from the Alerts page.
        </p>
      </section>

      {loaded && (
        <section className="fade-up fade-up-1 mt-6 space-y-5">
          <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5">
            <SectionKicker testId="kicker-capture-types">What to capture</SectionKicker>
            <div className="mt-4 space-y-4">
              {KINDS.map(({ key, label, icon: Icon, detail }) => (
                <div key={key} className="rounded-xl border border-[#e0e1da] bg-[#f7f7f1] p-4" data-testid={`panel-capture-${key}`}>
                  <div className="flex items-center gap-2">
                    <Icon size={16} className="text-[#203c49]" />
                    <h2 className="text-sm font-bold text-[#203c49]">{label}</h2>
                    <span className={`ml-auto rounded-full border px-2 py-0.5 text-[11px] font-semibold ${policy[key] === 'off' ? 'border-[#c6cbc3] text-[#687271]' : 'border-[#b9d8c5] bg-[#e1efe5] font-bold text-[#236047]'}`} data-testid={`status-capture-${key}`}>
                      {SETTING_LABELS[policy[key]]}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-[#687271]">{detail}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(['off', 'trigger', 'responder'] as const).map((setting) => (
                      <button
                        key={setting}
                        disabled={saving}
                        onClick={() => { void apply({ [key]: setting }); }}
                        className={`rounded-lg border px-3 py-2 text-[11px] font-bold transition-colors disabled:opacity-40 ${policy[key] === setting ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] text-[#687271] hover:border-[#203c49]'}`}
                        data-testid={`button-capture-${key}-${setting}`}
                      >
                        {SETTING_LABELS[setting]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5">
            <div className="flex items-center gap-2">
              <Clock3 size={16} className="text-[#203c49]" />
              <SectionKicker testId="kicker-capture-start-timing">When recording starts</SectionKicker>
            </div>
            <p className="mt-3 text-xs leading-5 text-[#687271]">
              Applies to every capture type that’s on. Try the same practice alert twice — once with
              each setting — and compare what each actually catches and how noticeable each is.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(['immediate', 'screen-off'] as const).map((timing) => (
                <button
                  key={timing}
                  disabled={saving}
                  onClick={() => { void apply({ timing }); }}
                  className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-40 ${policy.timing === timing ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] bg-[#f7f7f1] text-[#687271] hover:border-[#203c49]'}`}
                  data-testid={`button-capture-timing-${timing}`}
                >
                  <span className="flex items-center gap-2 text-xs font-bold">
                    {policy.timing === timing && <Check size={13} />}
                    {TIMING_LABELS[timing].label}
                  </span>
                  <span className={`mt-2 block text-[11px] leading-4 ${policy.timing === timing ? 'text-[#c2cec7]' : 'text-[#687271]'}`}>
                    {TIMING_LABELS[timing].detail}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5">
            <div className="flex items-center gap-2">
              <SwitchCamera size={16} className="text-[#203c49]" />
              <SectionKicker testId="kicker-camera-for-photo-&-video">Which camera to use</SectionKicker>
            </div>
            <p className="mt-3 text-xs leading-5 text-[#687271]">
              Applies to photo and video. Each clip is labeled with the camera it came from on the
              alert’s evidence panel.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(['back', 'front', 'both'] as const).map((camera) => (
                <button
                  key={camera}
                  disabled={saving}
                  onClick={() => { void apply({ camera }); }}
                  className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-40 ${policy.camera === camera ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] bg-[#f7f7f1] text-[#687271] hover:border-[#203c49]'}`}
                  data-testid={`button-capture-camera-${camera}`}
                >
                  <span className="flex items-center gap-2 text-xs font-bold">
                    {policy.camera === camera && <Check size={13} />}
                    {CAMERA_LABELS[camera].label}
                  </span>
                  <span className={`mt-2 block text-[11px] leading-4 ${policy.camera === camera ? 'text-[#c2cec7]' : 'text-[#687271]'}`}>
                    {CAMERA_LABELS[camera].detail}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#e8c880] bg-[#fff8e7] p-5">
            <div className="flex gap-3">
              <Eye size={17} className="mt-0.5 shrink-0 text-[#a06712]" />
              <div>
                <p className="text-sm font-bold text-[#765013]">The phone always shows it’s recording — and that’s on purpose.</p>
                <p className="mt-1 text-xs leading-5 text-[#765013]">
                  Stock Android shows the green mic/camera indicator whenever recording is on; it can’t be
                  hidden and this build doesn’t try. Recording never opens the app’s screen — the indicator is
                  the only visible trace. When a responder asks for evidence, the phone records the next time it
                  contacts the server — if the phone is sitting idle, Android may refuse to start the mic or
                  camera, and the phone reports exactly why to the timeline so it’s a measured fact, not a guess.
                </p>
              </div>
            </div>
          </div>

          {(error || saveError) && (
            saveError
              ? <FriendlyErrorMessage error={saveError} testId="text-capture-error" onRetry={retrySave} />
              : <FriendlyErrorMessage error={error ?? ''} testId="text-capture-error" onRetry={() => void reload()} />
          )}
          {savedFlash && (
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#236047]" data-testid="text-capture-saved">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4e9a70]" />
              Saved — the phone picks this up the next time it checks in.
            </p>
          )}
          {policy.updatedAt && (
            <p className="text-[11px] text-[#687271]">
              Last changed {new Date(policy.updatedAt).toLocaleString()}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

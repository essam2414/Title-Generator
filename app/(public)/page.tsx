import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PipelineAnimation } from '@/components/landing/pipeline-animation';

const REASONS = [
  {
    heading: 'Ranked, not guessed',
    body: 'Every suggestion is scored against the measured performance of real titles, so the order carries information. You are not reading five equally confident guesses.',
  },
  {
    heading: 'It has seen what failed, too',
    body: 'The reference set includes videos that underperformed, marked as such. A model that has only ever been shown winners has no reference for a weak line.',
  },
  {
    heading: 'Built for silent video',
    body: 'These are burned-in titles: the text you type over the clip, not captions and not a spoken hook. The whole pipeline is tuned for that one job.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto max-w-[1180px] px-6 py-6">
          <h1 className="font-display text-2xl leading-none tracking-tight text-ink sm:text-3xl">
            Hook Title Generator
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-6 pb-24 pt-12 sm:pt-16">
        <div className="grid gap-x-16 gap-y-14 lg:grid-cols-[minmax(0,1fr)_352px] lg:items-start">
          <section className="lg:col-start-1 lg:row-start-1">
            <h2 className="font-display text-[2.125rem] leading-[1.07] tracking-[-0.02em] text-balance sm:text-[2.875rem]">
              The words on screen decide who stops scrolling.
            </h2>
            <p className="mt-6 max-w-[48ch] text-lg text-ink-dim">
              Drop in a silent clip. Get five burned-in title ideas, each ranked against real
              titles whose performance has already been measured.
            </p>
          </section>

          <aside className="lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
            <div className="border border-border bg-bg-raised p-6">
              <p className="text-micro uppercase tracking-[0.12em] text-gold">Early access</p>
              <h2 className="mt-3 font-display text-xl leading-snug text-ink">
                Try the demo
              </h2>
              <p className="mt-2 text-sm text-ink-dim">
                Go straight to the title generator and try it with a video.
              </p>
              <Button asChild size="lg" className="mt-5 w-full">
                <Link href="/app">Enter</Link>
              </Button>
            </div>

            <p className="mt-4 border-l-2 border-border-strong py-1 pl-4 text-sm text-ink-muted">
              This is a beta. The output, features and design may change.
            </p>
          </aside>

          <div className="lg:col-start-1 lg:row-start-2">
            <section>
              <div className="mb-6 flex items-center gap-4">
                <h3 className="text-micro uppercase tracking-[0.14em] text-ink-muted">
                  How it works
                </h3>
                <span className="h-px flex-1 bg-border" />
              </div>
              <PipelineAnimation />
            </section>

            <section className="mt-16">
              <div className="mb-6 flex items-center gap-4">
                <h3 className="text-micro uppercase tracking-[0.14em] text-ink-muted">
                  Why it helps
                </h3>
                <span className="h-px flex-1 bg-border" />
              </div>
              <dl className="grid gap-px bg-border sm:grid-cols-3">
                {REASONS.map((reason) => (
                  <div key={reason.heading} className="bg-bg p-5 pt-6">
                    <dt className="font-display text-lg leading-snug text-ink">{reason.heading}</dt>
                    <dd className="mt-2 text-sm text-ink-dim">{reason.body}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FlavorSliders } from "../components/FlavorSliders";
import { ReviewForm } from "../components/ReviewForm";
import { ReviewSection } from "../components/ReviewSection";
import { StarRating } from "../components/StarRating";
import { EMPTY_REVIEW_STATE } from "../components/review-form-logic";

const SLUG = "demoroastseedone234";

describe("review form semantic rendering", () => {
  it("T-star-a11y: renders a required radio group with five roving radios", () => {
    const markup = renderToStaticMarkup(
      <StarRating value={3} onChange={vi.fn()} />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Overall score"');
    expect(markup).toContain('aria-required="true"');
    expect(markup.match(/role="radio"/g)).toHaveLength(5);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(4);
  });

  it("T-slider-a11y: renders labelled native sliders with untouched state and clear controls", () => {
    const markup = renderToStaticMarkup(
      <FlavorSliders values={EMPTY_REVIEW_STATE} onChange={vi.fn()} />,
    );

    expect(markup.match(/type="range"/g)).toHaveLength(5);
    expect(markup.match(/min="0"/g)).toHaveLength(5);
    expect(markup.match(/max="100"/g)).toHaveLength(5);
    expect(markup.match(/step="1"/g)).toHaveLength(5);
    expect(markup.match(/aria-valuetext="Not rated"/g)).toHaveLength(5);
    expect(markup.match(/>Not rated<\/output>/g)).toHaveLength(5);
    for (const label of ["Aroma", "Acidity", "Sweetness", "Body", "Aftertaste"]) {
      expect(markup).toContain(`aria-label="${label} rating"`);
    }

    const touchedMarkup = renderToStaticMarkup(
      <FlavorSliders
        values={{ ...EMPTY_REVIEW_STATE, acidity: 63 }}
        onChange={vi.fn()}
      />,
    );
    expect(touchedMarkup).toMatch(
      /<input(?=[^>]*aria-label="Acidity rating")(?=[^>]*aria-valuetext="63")[^>]*>/,
    );
  });

  it("T-form-labels: labels every text field and keeps the honeypot off-screen", () => {
    const markup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );

    expect(markup).toContain('for="reviewer-name"');
    expect(markup).toContain('for="brew-method"');
    expect(markup).toContain('for="review-notes"');
    const honeypot = markup.match(
      /<input(?=[^>]*name="website")[^>]*>/i,
    )?.[0];
    expect(honeypot).toBeDefined();
    expect(honeypot).toMatch(/tabindex="-1"/i);
    expect(honeypot).toMatch(/autocomplete="off"/i);
    expect(honeypot).toMatch(/aria-hidden="true"/i);
    expect(honeypot).toMatch(/position:absolute;left:-9999px/i);
    expect(markup).not.toMatch(/display\s*:\s*none/i);
    expect(markup).not.toMatch(/<input[^>]*\shidden(?:=|\s|>)/i);
    expect(honeypot).not.toMatch(/class=/);
  });

  it("T-brew-freetext: keeps brew method as bounded free text", () => {
    const markup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );
    const brewMethod = markup.match(
      /<input(?=[^>]*id="brew-method")[^>]*>/i,
    )?.[0];

    expect(brewMethod).toBeDefined();
    expect(brewMethod).toMatch(/maxlength="40"/i);
    expect(markup).not.toMatch(/<select|<datalist|<option/i);
  });

  it("T-token-source-guard: uses token roles and only honeypot inline styles", () => {
    const sources = ["ReviewForm.tsx", "StarRating.tsx", "FlavorSliders.tsx"].map(
      (file) =>
        readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8"),
    );
    const source = sources.join("\n");

    expect(source).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(source).not.toMatch(/\b(?:amber|orange|gray|stone)-[0-9]{2,3}\b/);
    expect(source.match(/style=\{\{/g)).toHaveLength(2);
    expect(sources[1]).not.toContain("style={{");
    expect(sources[2]).not.toContain("style={{");
  });

  it("T-themed-render: renders control groups as token-backed cards", () => {
    const markup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );
    const surfaceCards = markup.match(
      /class="(?=[^"]*\brounded-card\b)(?=[^"]*\bbg-surface\b)[^"]*"/g,
    );

    expect(surfaceCards).toHaveLength(5);
  });

  it("T-contrast-roles: uses accessible foreground roles for interactive text", () => {
    const formMarkup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );
    const submit = formMarkup.match(
      /<button(?=[^>]*type="submit")[^>]*>/i,
    )?.[0];
    const clearButtons = formMarkup.match(
      /<button[^>]*>Clear [^<]+ \(Not rated\)<\/button>/g,
    );
    const starMarkup = renderToStaticMarkup(
      <StarRating value={3} onChange={vi.fn()} />,
    );
    const stars = starMarkup.match(
      /<button(?=[^>]*role="radio")[^>]*>/g,
    );

    expect(submit).toContain("text-on-amber");
    expect(submit).not.toContain("text-foreground");
    expect(submit).not.toContain("text-[var(--rp-on-primary)]");
    expect(submit).toContain("hover:bg-primary");
    expect(submit).not.toContain("hover:bg-[var(--rp-primary-strong-hover)]");
    expect(clearButtons).toHaveLength(5);
    for (const clearButton of clearButtons ?? []) {
      expect(clearButton).toContain("text-foreground-muted");
      expect(clearButton).not.toContain("text-primary-strong");
    }
    expect(stars).toHaveLength(5);
    for (const unselectedStar of stars?.slice(3) ?? []) {
      expect(unselectedStar).toContain("text-foreground-muted");
      expect(unselectedStar).not.toContain("text-border");
    }
    expect(starMarkup.match(/>★<\/span>/g)).toHaveLength(3);
    expect(starMarkup.match(/>☆<\/span>/g)).toHaveLength(2);
  });

  it("T-control-boundaries: keeps fields, sliders, and stars visible and responsive", () => {
    const formMarkup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );
    const textControls = ["reviewer-name", "brew-method", "review-notes"].map(
      (id) => formMarkup.match(new RegExp(`<(?:input|textarea)(?=[^>]*id="${id}")[^>]*>`, "i"))?.[0],
    );
    const sliders = formMarkup.match(/<input(?=[^>]*type="range")[^>]*>/g);
    const starMarkup = renderToStaticMarkup(
      <StarRating value={3} onChange={vi.fn()} />,
    );
    const starGroup = starMarkup.match(
      /<div(?=[^>]*role="radiogroup")[^>]*>/,
    )?.[0];
    const stars = starMarkup.match(
      /<button(?=[^>]*role="radio")[^>]*>/g,
    );

    expect(textControls).not.toContain(undefined);
    for (const control of textControls) {
      expect(control).toContain("border-foreground-muted");
      expect(control).not.toContain("border-border");
    }
    expect(sliders).toHaveLength(5);
    for (const slider of sliders ?? []) {
      expect(slider).toContain("bg-foreground-muted");
      expect(slider).not.toContain("bg-[var(--rp-surface-muted)]");
      expect(slider).toContain("::-moz-range-thumb]:border-2");
      expect(slider).toContain("::-moz-range-thumb]:border-surface");
      expect(slider).toContain("::-webkit-slider-thumb]:border-2");
      expect(slider).toContain("::-webkit-slider-thumb]:border-surface");
    }
    expect(starGroup).toContain("gap-1");
    expect(starGroup).toContain("sm:gap-2");
    expect(stars).toHaveLength(5);
    for (const star of stars ?? []) {
      expect(star).toContain("text-3xl");
      expect(star).toContain("sm:text-4xl");
      expect(star).not.toMatch(/(?:^|\s)text-4xl(?:\s|$)/);
    }
  });

  it("T-no-fahrenheit: exposes no temperature field or Fahrenheit copy", () => {
    const markup = renderToStaticMarkup(
      <ReviewForm slug={SLUG} onSubmitted={vi.fn()} />,
    );
    expect(markup).not.toMatch(/temperature|fahrenheit|°\s*F/i);
  });

  it("T-empty-state-replaced: an empty review section includes the form", () => {
    const markup = renderToStaticMarkup(
      <ReviewSection slug={SLUG} reviews={[]} />,
    );

    expect(markup).toContain("Be the first to taste this roast");
    expect(markup).toContain("Review this roast");
    expect(markup).toContain('name="notes"');
  });
});

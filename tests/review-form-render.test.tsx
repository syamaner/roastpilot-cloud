import { renderToStaticMarkup } from "react-dom/server";
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
    expect(markup).not.toMatch(/class=/);
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

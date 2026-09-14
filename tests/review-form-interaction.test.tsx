// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlavorSliders } from "../components/FlavorSliders";
import { ReviewForm } from "../components/ReviewForm";
import { ReviewSection } from "../components/ReviewSection";
import { StarRating } from "../components/StarRating";
import { EMPTY_REVIEW_STATE } from "../components/review-form-logic";
import type { Review } from "@/lib/roast";

const SLUG = "demoroastseedone234";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as Response;
}

function stubFetch(response: Response | Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockReturnValue(Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function chooseScore(user: ReturnType<typeof userEvent.setup>, score = 5) {
  await user.click(
    screen.getByRole("radio", { name: `${score} out of 5 stars` }),
  );
}

function StatefulStarRating() {
  const [value, setValue] = useState<number | null>(null);
  return <StarRating value={value} onChange={setValue} />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StarRating interactions", () => {
  it("clicks a star and reflects the controlled checked value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<StarRating value={2} onChange={onChange} />);

    expect(
      screen.getByRole("radio", { name: "2 out of 5 stars" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    await user.click(screen.getByRole("radio", { name: "4 out of 5 stars" }));
    expect(onChange).toHaveBeenLastCalledWith(4);

    rerender(<StarRating value={4} onChange={onChange} />);
    expect(
      screen.getByRole("radio", { name: "4 out of 5 stars" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("moves focus and selection through repeated arrows, Home, and End", async () => {
    const user = userEvent.setup();
    render(<StatefulStarRating />);
    const first = screen.getByRole("radio", { name: "1 out of 5 stars" });
    const second = screen.getByRole("radio", { name: "2 out of 5 stars" });
    const third = screen.getByRole("radio", { name: "3 out of 5 stars" });
    const fifth = screen.getByRole("radio", { name: "5 out of 5 stars" });

    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{ArrowRight}");
    expect(third.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(third);
    await user.keyboard("{ArrowLeft}");
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{End}");
    expect(fifth.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(fifth);
    await user.keyboard("{Home}");
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(first);
  });

  it("supports alternate arrows, bounds, Enter, Space, and unrelated keys", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StarRating value={null} onChange={onChange} />);
    const first = screen.getByRole("radio", { name: "1 out of 5 stars" });
    const third = screen.getByRole("radio", { name: "3 out of 5 stars" });
    const fifth = screen.getByRole("radio", { name: "5 out of 5 stars" });

    first.focus();
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith(2);
    first.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(1);
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(1);
    first.focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(1);

    third.focus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith(3);

    fifth.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(5);
    await user.keyboard("x");
    expect(onChange).toHaveBeenCalledTimes(6);
  });
});

describe("FlavorSliders interactions", () => {
  it("marks a slider touched, clears it, and displays untouched state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <FlavorSliders values={EMPTY_REVIEW_STATE} onChange={onChange} />,
    );
    const fieldset = screen.getByRole("group", {
      name: "Flavor ratings (optional)",
    });

    expect(within(fieldset).getAllByText("Not rated", { exact: true })).toHaveLength(
      5,
    );
    fireEvent.change(screen.getByRole("slider", { name: "Acidity rating" }), {
      target: { value: "37" },
    });
    expect(onChange).toHaveBeenLastCalledWith("acidity", 37);

    await user.click(
      screen.getByRole("button", { name: "Clear Acidity (Not rated)" }),
    );
    expect(onChange).toHaveBeenLastCalledWith("acidity", null);

    rerender(
      <FlavorSliders
        values={{ ...EMPTY_REVIEW_STATE, acidity: 37 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("37", { selector: "output" })).toBeTruthy();
  });
});

describe("ReviewForm interactions", () => {
  it("blocks a submission without a score", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose an overall score",
    );
  });

  it("posts JSON, emits a complete optimistic review, and replaces the form", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));
    const onSubmitted = vi.fn();
    render(<ReviewForm slug={SLUG} onSubmitted={onSubmitted} />);

    await chooseScore(user, 4);
    for (const [label, value] of [
      ["Aroma rating", "10"],
      ["Acidity rating", "20"],
      ["Sweetness rating", "30"],
      ["Body rating", "40"],
      ["Aftertaste rating", "55"],
    ]) {
      fireEvent.change(screen.getByRole("slider", { name: label }), {
        target: { value },
      });
    }
    await user.type(screen.getByRole("textbox", { name: "First name (optional)" }), "Ada");
    await user.type(screen.getByRole("textbox", { name: "Brew method (optional)" }), "V60");
    await user.type(screen.getByRole("textbox", { name: "Tasting notes (optional)" }), "Apricot");

    const honeypot = document.querySelector<HTMLInputElement>('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot?.getAttribute("aria-hidden")).toBe("true");
    expect(honeypot?.tabIndex).toBe(-1);

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/r/${encodeURIComponent(SLUG)}/reviews`);
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const payload = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      score: 4,
      website: "",
      reviewerName: "Ada",
      notes: "Apricot",
      brewMethod: "V60",
      aroma: 10,
      acidity: 20,
      sweetness: 30,
      body: 40,
      aftertaste: 55,
    });
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(onSubmitted.mock.calls[0][0]).toMatchObject({
      public_slug: SLUG,
      reviewer_name: "Ada",
      score: 4,
      notes: "Apricot",
    });
    expect(onSubmitted.mock.calls[0][0].created_at).toEqual(expect.any(String));
    expect(screen.getByRole("status").textContent).toContain(
      "your tasting was saved",
    );
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("forwards a bot-filled honeypot to the server", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    const honeypot = document.querySelector<HTMLInputElement>(
      'input[name="website"]',
    );
    if (honeypot === null) throw new Error("honeypot input was not rendered");
    fireEvent.change(honeypot, {
      target: { value: "http://spam.example" },
    });
    await chooseScore(user);

    fireEvent.submit(
      screen.getByRole("button", { name: "Submit review" }).closest(
        "form",
      ) as HTMLFormElement,
    );

    const payload = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(payload.website).toBe("http://spam.example");
  });

  it("falls back to an empty honeypot value when the DOM value is unavailable", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    const honeypot = document.querySelector<HTMLInputElement>(
      'input[name="website"]',
    );
    if (honeypot === null) throw new Error("honeypot input was not rendered");
    vi.spyOn(honeypot, "value", "get").mockReturnValue(
      undefined as unknown as string,
    );
    await chooseScore(user);

    fireEvent.submit(
      screen.getByRole("button", { name: "Submit review" }).closest(
        "form",
      ) as HTMLFormElement,
    );

    const payload = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(payload.website).toBe("");
  });

  it("sends only the one flavor slider that was touched", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));
    render(<ReviewForm slug="roast/unsafe?" onSubmitted={vi.fn()} />);
    await chooseScore(user, 3);
    fireEvent.change(screen.getByRole("slider", { name: "Acidity rating" }), {
      target: { value: "63" },
    });

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/r/roast%2Funsafe%3F/reviews",
    );
    const payload = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    ) as Record<string, unknown>;
    expect(payload.acidity).toBe(63);
    for (const key of ["aroma", "sweetness", "body", "aftertaste"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it("shows server validation and preserves entered content", async () => {
    const user = userEvent.setup();
    stubFetch(
      jsonResponse(400, {
        error: "x",
        fieldErrors: { score: ["bad"] },
      }),
    );
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    await chooseScore(user);
    const notes = screen.getByRole("textbox", {
      name: "Tasting notes (optional)",
    }) as HTMLTextAreaElement;
    await user.type(notes, "Keep this note");

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(screen.getByRole("alert").textContent).toContain("bad");
    expect(notes.value).toBe("Keep this note");
  });

  it("shows client-owned rate-limit copy and preserves entered content", async () => {
    const user = userEvent.setup();
    stubFetch(jsonResponse(429, { error: "slow" }));
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    await chooseScore(user);
    const notes = screen.getByRole("textbox", {
      name: "Tasting notes (optional)",
    }) as HTMLTextAreaElement;
    await user.type(notes, "Still here");

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(screen.getByRole("alert").textContent).toMatch(/connection/i);
    expect(notes.value).toBe("Still here");
  });

  it("shows a generic retry error after a network failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    await chooseScore(user);
    const notes = screen.getByRole("textbox", {
      name: "Tasting notes (optional)",
    }) as HTMLTextAreaElement;
    await user.type(notes, "Do not lose me");

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(screen.getByRole("alert").textContent).toMatch(/try again/i);
    expect(notes.value).toBe("Do not lose me");
  });

  it("handles an unreadable error response and re-enables submit", async () => {
    const user = userEvent.setup();
    stubFetch(new Response("not json", { status: 415 }));
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    await chooseScore(user);

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    expect(screen.getByRole("alert").textContent).toMatch(/try again/i);
    expect(
      (screen.getByRole("button", { name: "Submit review" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("disables submit in flight and ignores a duplicate submission", async () => {
    const user = userEvent.setup();
    let resolveRequest: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    const fetchMock = stubFetch(pending);
    render(<ReviewForm slug={SLUG} onSubmitted={vi.fn()} />);
    await chooseScore(user);
    const submit = screen.getByRole("button", { name: "Submit review" });

    fireEvent.click(submit);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolveRequest?.(jsonResponse(200, { ok: true }));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});

describe("ReviewSection interactions", () => {
  it("prepends a submitted review without reloading", async () => {
    const user = userEvent.setup();
    stubFetch(jsonResponse(200, { ok: true }));
    const existing: Review = {
      public_slug: SLUG,
      reviewer_name: "Bo",
      score: 3,
      aroma: null,
      acidity: null,
      sweetness: null,
      body: null,
      aftertaste: null,
      brew_method: null,
      notes: "Existing review",
      created_at: "2026-09-13T12:00:00.000Z",
    };
    render(<ReviewSection slug={SLUG} reviews={[existing]} />);
    await chooseScore(user, 5);
    await user.type(
      screen.getByRole("textbox", { name: "Tasting notes (optional)" }),
      "New optimistic review",
    );

    await user.click(screen.getByRole("button", { name: "Submit review" }));

    const rows = await screen.findAllByTestId("review-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("New optimistic review")).toBeTruthy();
    expect(within(rows[1]).getByText("Existing review")).toBeTruthy();
  });
});

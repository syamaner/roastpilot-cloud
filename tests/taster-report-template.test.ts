import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface FormField {
  type: string;
  id?: string;
  attributes: {
    label?: string;
    description?: string;
    placeholder?: string;
    value?: string;
  };
  validations?: { required?: boolean };
}

interface IssueForm {
  name: string;
  description: string;
  title: string;
  labels: string[];
  body: FormField[];
}

const template = parse(
  readFileSync(
    join(process.cwd(), ".github/ISSUE_TEMPLATE/taster-report.yml"),
    "utf8",
  ),
) as IssueForm;

describe("taster report issue form", () => {
  it("T-template-shape: has the required form fields and privacy notice", () => {
    expect(template).toMatchObject({
      name: "Taster report",
      description: expect.any(String),
      title: "[taster] ",
      labels: ["taster-report", "needs-triage"],
    });
    expect(template.body).toHaveLength(4);
    expect(template.body.map(({ type }) => type)).toEqual([
      "markdown",
      "input",
      "textarea",
      "textarea",
    ]);
    expect(template.body.every(({ type }) =>
      ["markdown", "input", "textarea", "dropdown", "checkboxes"].includes(type),
    )).toBe(true);
    expect(template.body[0].attributes.value).toMatch(/PUBLIC repository/);
    expect(template.body[0].attributes.value).toMatch(/Do NOT include your name, email, IP address, or any personal detail/);
    expect(template.body[0].attributes.value).toMatch(/anonymous/);
    expect(template.body.slice(1).map(({ id, attributes, validations }) => ({
      id,
      label: attributes.label,
      required: validations?.required,
    }))).toEqual([
      { id: "page", label: "Which page?", required: true },
      { id: "what-happened", label: "What went wrong?", required: true },
      { id: "expected", label: "What did you expect?", required: false },
    ]);
    expect(template.body[1].attributes.description).toMatch(/\/r\/… URL or slug/);
  });

  it("T-template-no-pii: solicits no identifying or contact information", () => {
    for (const field of template.body) {
      const metadata = [
        field.id,
        field.attributes.label,
        field.attributes.description,
        field.attributes.placeholder,
      ].filter(Boolean).join(" ");
      expect(metadata).not.toMatch(/name|e-?mail|phone|\bip\b|username|handle|account|login|contact/i);
    }
  });

  it("T-config-blank: keeps blank issues enabled", () => {
    const config = parse(
      readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/config.yml"), "utf8"),
    ) as { blank_issues_enabled?: boolean };
    expect(config.blank_issues_enabled).toBe(true);
  });
});

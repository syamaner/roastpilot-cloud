const TASTER_REPORT_URL =
  "https://github.com/syamaner/roastpilot-cloud/issues/new?template=taster-report.yml";

export function ReportProblemLink() {
  return (
    <a
      href={TASTER_REPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      Report a problem with this page
    </a>
  );
}

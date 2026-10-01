// A new-issue link on the app's GitHub repository, prefilled with the
// reporting instructions and the page the report was started from.
export function bugReportHref(pathname: string): string {
  return (
    "https://github.com/lets-encode/lets-encode/issues/new?" +
    new URLSearchParams({
      body:
        "**Describe the problem in a few sentences:** what you did, what you expected, and what happened instead.\n\n\n\n" +
        "**Add a screenshot:** paste it or drag the image file into this box.\n\n\n\n" +
        `---\nPage: ${pathname}`,
    })
  );
}

function matchesAnyPattern(title, titlePatterns) {
  return titlePatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(title);
  });
}

export async function supersedeTrackingIssues({ github, context, keepIssueNumber, titlePatterns }) {
  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'open',
    per_page: 100,
  });

  const superseded = openIssues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.number !== keepIssueNumber &&
      matchesAnyPattern(issue.title, titlePatterns),
  );

  for (const issue of superseded) {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      body: `Superseded by #${keepIssueNumber}; retaining only the most recent automated report.`,
    });
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      state: 'closed',
      state_reason: 'not_planned',
    });
  }

  return superseded.map((issue) => issue.number);
}

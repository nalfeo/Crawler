const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
const graphqlUrl = process.env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql';

function headers(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'crawler-ci-recovery',
    ...extra,
  };
}

export async function request(token, path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method || 'GET',
    headers: headers(token, options.headers),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(
      `GitHub ${options.method || 'GET'} ${path} failed (${response.status}): ${data?.message || text}`,
    );
    error.status = response.status;
    error.data = data;
    error.headers = response.headers;
    throw error;
  }
  return { data, headers: response.headers, status: response.status };
}

export async function paginate(token, path) {
  const separator = path.includes('?') ? '&' : '?';
  const results = [];
  let page = 1;
  while (true) {
    const response = await request(token, `${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(response.data)) {
      throw new Error(`Expected paginated array from ${path}`);
    }
    results.push(...response.data);
    if (response.data.length < 100) {
      return results;
    }
    page += 1;
  }
}

export async function graphql(token, query, variables = {}) {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL failed: ${payload.errors?.map((error) => error.message).join('; ') || response.status}`,
    );
  }
  return payload.data;
}

export async function listReviewThreads(token, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          assignees(first: 50) { nodes { id login } }
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 100) {
                nodes {
                  id
                  body
                  url
                  author { login }
                  authorAssociation
                }
              }
            }
          }
        }
      }
    }`;
  const threads = [];
  let cursor = null;
  let pullRequest = null;
  do {
    const data = await graphql(token, query, { owner, repo, number, cursor });
    pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error(`PR #${number} was not found`);
    }
    threads.push(...(pullRequest.reviewThreads?.nodes || []));
    cursor = pullRequest.reviewThreads?.pageInfo?.hasNextPage
      ? pullRequest.reviewThreads.pageInfo.endCursor
      : null;
  } while (cursor);
  return {
    id: pullRequest.id,
    assignees: pullRequest.assignees?.nodes || [],
    threads,
  };
}

export async function listClosingIssues(token, owner, repo, number) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          closingIssuesReferences(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              labels(first: 100) { nodes { name } }
            }
          }
        }
      }
    }`;
  const issues = [];
  let cursor = null;
  do {
    const data = await graphql(token, query, { owner, repo, number, cursor });
    const references = data.repository?.pullRequest?.closingIssuesReferences;
    issues.push(...(references?.nodes || []));
    cursor = references?.pageInfo?.hasNextPage ? references.pageInfo.endCursor : null;
  } while (cursor);
  return issues;
}

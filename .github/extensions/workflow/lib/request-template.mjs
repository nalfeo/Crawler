/**
 * Pure render/parse contract for the Briefs full-template editor.
 *
 * These functions are serialized into the workflow iframe, so they must remain
 * closure-free and browser-compatible.
 */

export function templateSection(text, heading, nextHeadings) {
  function lineHeadingIndex(candidate, from) {
    var startAt = from || 0;
    while (startAt < text.length) {
      var found = text.indexOf(candidate, startAt);
      if (found < 0) return -1;
      if (found === 0 || text.charAt(found - 1) === '\n') return found;
      startAt = found + candidate.length;
    }
    return -1;
  }
  var start = lineHeadingIndex(heading, 0);
  if (start < 0) return '';
  start += heading.length;
  var end = text.length;
  nextHeadings.forEach(function (nextHeading) {
    var next = lineHeadingIndex(nextHeading, start);
    if (next >= 0 && next < end) end = next;
  });
  return text.slice(start, end).trim();
}

export function renderRequestTemplate(fields) {
  return [
    'FULL SYNTHESIS REQUEST',
    '',
    'Asset name: ' + (fields.name || '[not entered]'),
    'Additional direction:',
    fields.brief || '[none]',
    '',
    'Sprite type: ' + fields.type,
    'Sprite footprint: ' + fields.size,
    'Floor intensity: ' + (fields.floorNumber || '[none]'),
    'Floor context: ' + (fields.floorContext || 'none'),
    'Enemy family context: ' + (fields.familyContext || 'none'),
    'Mob role context: ' + (fields.role || 'none'),
    'Request priority: ' + fields.priority,
    'Requester identity: ' + (fields.requester || 'none'),
    '',
    'Crawler design-language injection (always applied):',
    fields.crawlerDesignLanguage,
    '',
    'Sprite category design-language injection:',
    fields.categoryInjection || '[resolved after automatic type classification]',
    '',
    'Floor design-language injection:',
    fields.floorInjection || '[none]',
    '',
    'Family/theme design-language injection:',
    fields.familyInjection || '[none]',
    '',
    'The request above is sent to Synthesize after Generate Brief, with the selected game-derived sources and request-local injection overrides.',
  ].join('\n');
}

export function parseRequestTemplate(text) {
  return {
    name: templateSection(text, 'Asset name:', ['Additional direction:']),
    brief: templateSection(text, 'Additional direction:', ['Sprite type:']),
    type: templateSection(text, 'Sprite type:', ['Sprite footprint:']),
    size: templateSection(text, 'Sprite footprint:', ['Floor intensity:']),
    floorNumber: templateSection(text, 'Floor intensity:', ['Floor context:']),
    floorContext: templateSection(text, 'Floor context:', ['Enemy family context:']),
    familyContext: templateSection(text, 'Enemy family context:', ['Mob role context:']),
    role: templateSection(text, 'Mob role context:', ['Request priority:']),
    priority: templateSection(text, 'Request priority:', ['Requester identity:']),
    requester: templateSection(text, 'Requester identity:', [
      'Crawler design-language injection (always applied):',
    ]),
    categoryInjection: templateSection(text, 'Sprite category design-language injection:', [
      'Floor design-language injection:',
    ]),
    floorInjection: templateSection(text, 'Floor design-language injection:', [
      'Family/theme design-language injection:',
    ]),
    familyInjection: templateSection(text, 'Family/theme design-language injection:', [
      'The request above',
    ]),
  };
}

export function normalizeCategoryOverride(value, type, categoryDesignLanguage) {
  var normalized = String(value || '').trim();
  var canonical = type === 'auto' ? '' : String(categoryDesignLanguage[type] || '').trim();
  return normalized === canonical ? '' : normalized;
}

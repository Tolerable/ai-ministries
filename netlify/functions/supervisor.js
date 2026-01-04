exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { agent, status, question } = body;
  const agentUpper = (agent || 'UNKNOWN').toUpperCase();

  // If they have a question, route them
  if (question) {
    const q = question.toLowerCase();
    
    if (q.includes('key') || q.includes('push') || q.includes('deploy')) {
      return respond('Ask INTOLERANT before proceeding. Do not guess.');
    }
    if (q.includes('stuck') || q.includes('error') || q.includes('broken')) {
      return respond('Use SPEAK to get Rev attention. Do not proceed without guidance.');
    }
    if (q.includes('permission') || q.includes('should i')) {
      return respond('Ask Rev. Use SPEAK if urgent. Wait for response.');
    }
    
    return respond('If unsure, ask INTOLERANT or Rev. Do not guess. Do not improvise.');
  }

  // Status-based responses
  const s = (status || '').toLowerCase();

  if (s.includes('idle') || s.includes('waiting') || s === '') {
    return respond('Check mailbox. Respond to new messages. If none, rest 30 seconds and check again.');
  }

  if (s.includes('done') || s.includes('complete') || s.includes('finished')) {
    return respond('Send update to mailbox. Check for new tasks. Run compliance loop if not running.');
  }

  if (s.includes('working') || s.includes('coding') || s.includes('editing')) {
    return respond('Continue. Before any push: run code_review.py --staged. All files must APPROVE.');
  }

  if (s.includes('error') || s.includes('stuck') || s.includes('blocked')) {
    return respond('Use SPEAK to alert Rev. Do not guess at solutions. Wait for guidance.');
  }

  if (s.includes('pushing') || s.includes('deploy')) {
    return respond('STOP. Run code_review.py --staged first. All files must APPROVE before push.');
  }

  // Agent-specific nudges
  if (agentUpper === 'BLACK') {
    return respond('Check mailbox for INTOLERANT messages. Run compliance loop. No keys in code. Ever.');
  }

  if (agentUpper === 'INTOLERANT') {
    return respond('Check mailbox for BLACK submissions. Review code for violations. Block bad pushes.');
  }

  if (agentUpper === 'CYAN' || agentUpper === 'VIOLET') {
    return respond('Check mailbox. Respond to queries. Use SPEAK if Rev needs to know something.');
  }

  // Default
  return respond('Check mailbox. Rest 30 seconds. Check again. Stay responsive.');
};

function respond(instruction) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction })
  };
}

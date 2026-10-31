/*
 * rules.js - the built-in rule set for the "Explain" phase. Plain data, no code is run from the page text.
 * Everything here is ON-DEVICE pattern matching (regular expressions on single sentences). It is NOT AI, it uses no
 * model, and it makes no network calls. Each rule has:
 *   id, title, severity (High|Medium|Low), priority (tie-break for ranking; lower = shown first),
 *   patterns: [ { all: [regex, ...], severity? } ]   a sentence matches when ALL regexes of one pattern match.
 *                                                    A pattern may set its own severity (default: the rule's).
 *   exclude:  [regex]       a sentence matching any of these is ignored (for example "we do NOT sell your data")
 *   escalate: [{re, severity}]   raise the severity of a matching sentence (for example "without notice")
 *   mitigators: [{ all:[regex], severity, note }]   another sentence that softens the rule (for example an opt-out)
 *   explain:  plain-English explanation shown with every quote
 *   line:     ONE plain-English sentence shown to the user (a pattern or an escalator may carry its own `line` that
 *             replaces it when that wording is what produced the finding)
 * Quantifiers are bounded ({0,N}) so a long sentence cannot make matching slow.
 * Limits (honest): sentence-level patterns can miss unusual wording and can match wording that is more harmless than it
 * looks. Not finding a rule does NOT prove the terms are silent on it. Informational, not legal advice.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var I = 'i';
  function r(src) { return new RegExp(src, I); }

  var NEG_SELL = r("\\b(do not|does not|don't|doesn't|will not|won't|never|not|no longer)\\s+(\\w+\\s+){0,3}(sell|sale|sold|rent)\\b");
  // A rule aimed at the USER ("You may not use the API ... for selling users' personal information"): not the company selling anything.
  // (But "you may not opt out of the sale ..." still counts: those verbs are excluded from the pattern.)
  var USER_MAY_NOT_SELL = r("\\b(you|users?|customers?)\\s+(may|must|shall|can|will)\\s+not\\b(?!\\s+(opt|object|limit|stop|prevent|refuse|withdraw|restrict|decline)\\b).{0,200}\\b(selling|sell|sale of|sold|renting)\\b");
  // "In a merger, acquisition or sale of assets, ... personal information is transferred" is not selling data to others.
  // First form: the sentence never says sell/sold at all. Second: it does, but only as part of that merger / sale-of-assets event
  // ("We may share, sell, or transfer information about you in connection with a merger ...").
  var MERGER_WORDS = "(merger|acquisition|bankruptcy|reorgani[sz]ation|sale of (all|substantially|assets|the (business|company)))";
  var MERGER_ONLY = r("^(?![\\s\\S]*\\b(sell|sells|selling|sold)\\b)[\\s\\S]*\\b" + MERGER_WORDS);
  var MERGER_EVENT = r("\\b(in connection with|in the event of|as part of|in a|in an|during|upon|if we|if the company)\\s+(\\w+[,]?\\s+){0,4}?" + MERGER_WORDS);
  // A "your rights" sentence ("You have the right to request that we disclose ... the categories of third parties to whom we sell") describes a request, not a sale;
  // a verbless heading ("Business purpose of selling or sharing personal information") says nothing; a quoted, defined term ("previously \u201csold\u201d (as defined by ...)") is a note about opt-outs.
  var RIGHTS_REQUEST = r("\\b(you have the right to|right to request|you may request|you can request|request that we (disclose|tell))\\b");
  var HEADING_ONLY = r("^(?![\\s\\S]*\\b(we|us|our|they|their|may|can|will|might|have|has|does|do|did|are|is|was|were|be|been|could|would|should|you|your|shall|must)\\b)");
  var QUOTED_SOLD = r("[\\u201c\"']\\s*(sold|sell|sale)\\s*[\\u201d\"']");
  var NEG_SHARE = r("\\b(do not|does not|don't|doesn't|will not|won't|never)\\s+(\\w+\\s+){0,3}(share|disclose|provide|transfer)\\b.{0,80}\\b(third[- ]part|partners?|advertis)");
  var NOT_THEM = r("\\b(grant|grants|give|gives|granting)\\s+(to\\s+)?(you|users?|the user)\\b");
  var SUBJECT_YOU_CANCEL = r("\\byou\\s+(may|can|are free to|have the right to)\\s+(\\w+\\s+){0,2}(cancel|close|delete|deactivate|terminate|stop)\\b");

  var RULES = [
    {
      id: 'arbitration', title: 'Forced (binding) arbitration', severity: 'High', priority: 1,
      patterns: [
        { all: [r('\\bbinding arbitration\\b')] },
        { all: [r('\\b(arbitrators?|arbitration (proceedings?|panel|award|rules|agreement|provision|clause))\\b')] },
        { all: [r('\\barbitrat(ion|e|ed|ing)\\b'), r('\\b(shall|must|will|agree|agrees|final|binding|resolved|settled|submitted?|exclusive)\\b')] },
        { all: [r('\\b(disputes?|claims?|controvers\\w+|disagreements?|causes of action)\\b.{0,200}\\barbitrat(ion|or|ors|e|ed|ing)\\b')] },
        { all: [r('\\barbitrat(ion|or|ors|e|ed|ing)\\b.{0,200}\\b(disputes?|claims?|controvers\\w+|disagreements?)\\b')] }
      ],
      exclude: [r("\\b(no|not|without|never)\\s+(\\w+\\s+){0,3}(mandatory|binding|required)?\\s*arbitration\\b"), r("\\b(do|does|will|shall) not (require|use|apply)\\b.{0,60}arbitrat")],
      mitigators: [
        { all: [r('\\bopt(ing)?[- ]out\\b.{0,160}\\barbitrat')], severity: 'Medium', note: 'The terms also appear to describe a way to opt out of arbitration. Check the deadline and how to do it.' },
        { all: [r('\\barbitrat\\w*.{0,200}\\bopt(ing)?[- ]out\\b')], severity: 'Medium', note: 'The terms also appear to describe a way to opt out of arbitration. Check the deadline and how to do it.' },
        { all: [r('\\b(reject|decline)\\b.{0,60}\\barbitration\\b')], severity: 'Medium', note: 'The terms also appear to describe a way to reject arbitration. Check the deadline and how to do it.' }
      ],
      explain: 'Arbitration means that if you have a dispute with the company, a private arbitrator decides it instead of a judge or jury in court. The decision is usually final, with very limited appeal. It can be faster, but you give up the usual court process.',
      line: 'Disputes go to private arbitration instead of a court.'
    },
    {
      id: 'class_action', title: 'Class-action waiver', severity: 'High', priority: 2,
      patterns: [
        { all: [r('\\b(class[- ]action|class[- ]wide|collective (action|proceeding|arbitration)|representative (action|proceeding|basis|capacity)|class (basis|member|plaintiff))\\b'), r('\\b(waive|waiver|waives|forgo|give up|gives? up|may not|cannot|can not|no right|not entitled|only (on|in) an? individual|individual (basis|capacity)|not as a (plaintiff|class))\\b')] },
        { all: [r('\\b(only|solely)\\s+(on|in)\\s+(your|an)\\s+individual\\s+(capacity|basis)\\b')] }
      ],
      exclude: [r('\\b(do|does) not waive\\b'), r("\\b(you )?(may|can) (bring|join|participate in)\\b.{0,30}\\bclass[- ]action")],
      explain: 'A class-action waiver means you cannot join or start a group lawsuit against the company. Each person has to bring a claim on their own, which can make small harms (for example a small unfair charge) hard to pursue in practice.',
      line: 'You can\'t sue them in a class action lawsuit.'
    },
    {
      id: 'jury_waiver', title: 'Jury trial waiver', severity: 'High', priority: 3,
      patterns: [
        { all: [r('\\bjury\\b'), r('\\b(waive|waiver|waives|forgo|give up|gives? up|no right|not entitled|without a jury)\\b')] },
        { all: [r('\\bbench trial\\b')] }
      ],
      exclude: [r('\\b(do|does) not waive\\b')],
      explain: 'A jury trial waiver means that if a dispute does end up in court, a judge decides it and not a jury of ordinary people. You give up your right to ask for a jury.',
      line: 'You give up your right to a jury trial.'
    },
    {
      id: 'data_sharing', title: 'Your data is sold or shared with others', severity: 'Medium', priority: 4,
      patterns: [
        { all: [r('\\b(sell|sells|selling|sold|sale of|rent|rents|renting)\\b.{0,80}\\b(personal (data|information)|your (data|information)|user data|information about you|customer data|your details)')], severity: 'High', line: 'They may sell your personal data.' },
        { all: [r('\\b(personal (data|information)|your (data|information)|information about you)\\b.{0,100}\\b(is|are|may be|can be|will be)\\s+(sold|rented)\\b')], severity: 'High', line: 'They may sell your personal data.' },
        { all: [r('\\b(share|shares|sharing|shared|disclose|discloses|disclosing|provide|provides|transfer|transfers|make available|give|gives)\\b.{0,100}\\b(personal (data|information)|your (data|information)|information about you|usage data|your details|data about you)\\b.{0,140}\\b(third[- ]part(y|ies)|partners?|advertis\\w+|affiliates?|marketing|data brokers?|analytics providers?)')], severity: 'Medium' },
        { all: [r('\\b(third[- ]part(y|ies)|advertis\\w+|data brokers?|marketing partners?|business partners?)\\b.{0,140}\\b(personal (data|information)|your (data|information)|information about you)\\b'), r('\\b(share|shared|sharing|disclose|disclosed|provide|provided|access|receive|receives|obtain|use)\\b')], severity: 'Medium' },
        { all: [r('\\b(share|shares|sharing|disclose|discloses|disclosing)\\b.{0,100}\\b(personal (data|information)|your (data|information)|information about you)\\b.{0,100}\\b(service providers?|vendors?|processors?|contractors?)\\b')], severity: 'Low', line: 'They share some of your data with companies that help run the service.' }
      ],
      exclude: [NEG_SELL, NEG_SHARE, USER_MAY_NOT_SELL, MERGER_ONLY, MERGER_EVENT, RIGHTS_REQUEST, HEADING_ONLY, QUOTED_SOLD],
      explain: 'The company says it may sell your personal information or pass it to other companies (partners, advertisers, affiliates and similar). Once shared, your data is also handled under those companies\' rules, and it is hard to take back. Sharing with service providers who work for the company (hosting, payments) is usually less of a concern than selling or sharing for advertising.',
      line: 'They may share your data with other companies, such as advertisers or partners.'
    },
    {
      id: 'auto_renewal', title: 'Auto-renewal / recurring billing', severity: 'Medium', priority: 5,
      patterns: [
        { all: [r('\\bauto[- ]?renew\\w*')] },
        { all: [r('\\b(renews?|renewed|renewal)\\b.{0,80}\\bautomatic\\w*')] },
        { all: [r('\\bautomatic\\w*.{0,60}\\brenew\\w*')] },
        { all: [r('\\b(recurring|subscription)\\b.{0,60}\\b(bill\\w*|charge\\w*|payments?|fees?)\\b')] },
        { all: [r('\\bwill (be )?(automatically )?(charged|billed)\\b.{0,100}\\b(each|every|monthly|annually|yearly|weekly|until you cancel|on a recurring)')] },
        { all: [r('\\buntil you cancel\\b')] },
        { all: [r('\\bfree trial\\b.{0,140}\\b(charged|billed|convert\\w*|automatically)\\b')] }
      ],
      exclude: [r("\\b(does not|do not|will not|won't|doesn't|not)\\s+(\\w+\\s+){0,2}(auto[- ]?renew|automatically renew|renew automatically)"), r('\\bno auto[- ]?renew')],
      escalate: [{ re: r('\\b(non[- ]refundable|no refunds?|not refundable|cannot be refunded)\\b'), severity: 'High', line: 'Paid plans renew automatically and may not be refundable.' }],
      explain: 'Your plan may renew by itself and your payment method may be charged again each period until you cancel. Check the renewal date, how and when you have to cancel, and what the refund rules are, so a renewal does not surprise you.',
      line: 'Paid plans renew and bill you automatically until you cancel.'
    },
    {
      id: 'unilateral_changes', title: 'The company can change the terms on its own', severity: 'Medium', priority: 6,
      patterns: [
        { all: [r('\\b(may|can|reserves? the right to|has the right to|have the right to|at any time)\\b.{0,60}\\b(change|modify|update|amend|revise|alter|replace)\\b.{0,80}\\b(these terms|this agreement|the terms|terms of (service|use)|these conditions|this policy|our policies|the agreement|the service)\\b')] },
        { all: [r('\\b(change|modify|update|amend|revise)\\b.{0,40}\\b(these terms|this agreement|the terms|terms of (service|use))\\b.{0,80}\\b(at any time|from time to time|without (prior )?notice|in (our|its) sole discretion)\\b')] },
        { all: [r('\\b(continued|continuing)\\s+(use|access)\\b.{0,100}\\b(constitutes?|means|will be deemed|is deemed|indicates?|signif\\w+)\\b.{0,60}\\b(accept\\w*|agree\\w*|consent)')] },
        { all: [r('\\b(keep|continue|continues)\\s+using\\b.{0,80}\\baccept\\w*\\b')] }
      ],
      exclude: [r("\\b(will not|won't|shall not|cannot|may not)\\s+(\\w+\\s+){0,2}(change|modify|amend)\\b.{0,60}\\bwithout\\b.{0,30}\\b(your )?(consent|agreement|notice)")],
      escalate: [{ re: r('\\bwithout (prior |any |advance |further |written )?(notice|notification)\\b'), severity: 'High', line: 'They can change these terms without telling you.' }],
      explain: 'The company can rewrite the rules after you have agreed, and you may be treated as accepting the new version simply by continuing to use the service. Look for whether they promise to tell you, how, and how far ahead.',
      line: 'They can change these terms later, and using the service means you accept the change.'
    },
    {
      id: 'user_content_license', title: 'License / rights to your content', severity: 'Medium', priority: 7,
      patterns: [
        { all: [r('\\byou\\s+(hereby\\s+)?(grant|give|gives|assign|authori[sz]e)\\b.{0,80}\\b(licen[cs]es?|rights?)\\b'), r('\\b(content|submissions?|materials?|posts?|feedback|ideas|contributions?|uploads?|data|host|display|use|reproduce|modify|distribute|sublicense|publish|copy|adapt)\\b')] },
        { all: [r('\\b(licen[cs]e|rights?)\\b.{0,120}\\b(your|user|users\'|customer)\\s+(content|submissions?|materials?|posts?|data|feedback|contributions?)\\b')] },
        { all: [r('\\byou (hereby )?assign\\b.{0,60}\\b(all|any)\\b.{0,40}\\b(rights?|title|interest)\\b')], severity: 'High', line: 'You hand over ownership of what you submit to them.' }
      ],
      exclude: [NOT_THEM],
      escalate: [{ re: r('\\b(perpetual|irrevocabl\\w+|in perpetuity)\\b'), severity: 'High', line: 'You give them a lasting, wide licence to use what you post or upload.' }],
      explain: 'By posting or uploading, you give the company permission (a licence) to use your content, for example to host, copy, show or adapt it. How wide that permission is matters: words like "perpetual", "irrevocable", "worldwide" or "sublicensable" mean it can last forever or be passed to others. Usually you still own your content.',
      line: 'You give them a licence to use what you post or upload.'
    },
    {
      id: 'liability_disclaimer', title: 'Liability limits and disclaimers', severity: 'Medium', priority: 8,
      patterns: [
        { all: [r('\\b(limit\\w*|exclud\\w*|disclaim\\w*)\\b.{0,60}\\b(liabilit\\w+|responsib\\w+)\\b')] },
        { all: [r('\\b(shall|will|be|are|is)\\s+not\\s+(be\\s+)?(held\\s+)?(liable|responsible)\\b')] },
        { all: [r('\\bin no event\\b.{0,120}\\bliab\\w+')] },
        { all: [r('\\bliabilit\\w+\\b.{0,80}\\b(limited to|shall not exceed|will not exceed|not exceed|capped at|exceed)\\b')] },
        { all: [r('\\b(indirect|incidental|consequential|special|punitive|exemplary)\\b.{0,60}\\bdamages\\b')] },
        { all: [r('\\b(indemnif\\w+|hold harmless|defend and hold)\\b')], line: 'You may have to cover their costs if a claim comes from your use.' },
        { all: [r('\\bas[- ]is\\b')], severity: 'Low', line: 'The service is provided "as is", with no promises it will work or be accurate.' },
        { all: [r('\\bas[- ]available\\b')], severity: 'Low', line: 'The service is provided "as is", with no promises it will work or be accurate.' },
        { all: [r('\\b(without|no|any)\\s+(express\\s+or\\s+implied\\s+)?warrant(y|ies)\\b')], severity: 'Low', line: 'The service is provided "as is", with no promises it will work or be accurate.' },
        { all: [r('\\bdisclaim\\w*\\b.{0,80}\\bwarrant\\w+')], severity: 'Low', line: 'The service is provided "as is", with no promises it will work or be accurate.' },
        { all: [r('\\b(merchantability|fitness for a particular purpose)\\b')], severity: 'Low', line: 'The service is provided "as is", with no promises it will work or be accurate.' }
      ],
      exclude: [r('\\bnothing in\\b.{0,100}\\b(exclude|limit|affect)'), r('\\b(does|do|shall|will) not (exclude|limit)\\b.{0,60}liabilit')],
      explain: 'These clauses cap how much the company has to pay if something goes wrong (sometimes to a small amount), say it is not responsible for certain kinds of loss, and say the service comes "as is" with no promises. Indemnity clauses can also make you cover the company\'s costs in some situations. In practice, you may not be able to recover much if the service fails or harms you.',
      line: 'They limit what they owe you if something goes wrong.'
    },
    {
      id: 'termination', title: 'Account can be ended or suspended by the company', severity: 'Medium', priority: 9,
      patterns: [
        { all: [r('\\b(suspend|terminate|close|deactivate|disable|cancel|restrict|delete|remove|ban|block)\\w*\\b.{0,80}\\b(accounts?|access|your use|the service|services)\\b.{0,120}\\b(at any time|for any reason|any reason|sole discretion|without (prior )?notice|without cause|no reason|at our discretion|at its discretion)\\b')] },
        { all: [r('\\b(at any time|for any reason|sole discretion|without (prior )?notice|without cause|at our discretion|at its discretion)\\b.{0,120}\\b(suspend|terminate|close|deactivate|disable|ban)\\w*\\b.{0,60}\\b(accounts?|access|you|your)\\b')] },
        { all: [r('\\b(we|company|provider)\\b.{0,20}\\b(may|can|reserves? the right to|has the right to|have the right to)\\b.{0,40}\\b(suspend|terminate|close|deactivate|disable|ban)\\w*\\b.{0,60}\\b(accounts?|access)\\b')], severity: 'Low', line: 'They can suspend or close your account.' }
      ],
      exclude: [SUBJECT_YOU_CANCEL],
      explain: 'The company can suspend or close your account. When this is allowed "at any time" or "for any reason", you could lose access (and possibly content or paid time) without a say. When it is limited to breaking the rules, it is less of a concern, but check whether you get notice and a chance to respond.',
      line: 'They can close your account at any time, for any reason.'
    },
    {
      id: 'governing_law', title: 'Governing law and where disputes are heard', severity: 'Low', priority: 10,
      patterns: [
        { all: [r('\\b(governed by|construed (in accordance )?(with|under)|interpreted (in accordance )?(with|under)|subject to the laws)\\b.{0,100}\\blaws?\\b')] },
        { all: [r('\\bexclusive (jurisdiction|venue)\\b')], severity: 'Medium', line: 'You may have to bring a dispute in the courts they choose.' },
        { all: [r('\\b(submit|consent|agree)\\b.{0,80}\\b(jurisdiction|venue)\\b')], severity: 'Medium', line: 'You may have to bring a dispute in the courts they choose.' },
        { all: [r('\\b(courts?|venue|jurisdiction)\\b.{0,100}\\b(located in|of (the )?(state|county|city|country|province)|in (the )?(state|county|city|country))\\b')] }
      ],
      exclude: [],
      explain: 'This says which place\'s laws apply and, often, which courts you must use. If that is far from where you live, bringing a claim can be harder and more expensive. Some places\' consumer laws still apply to you regardless of what the terms say.',
      line: 'A particular place\'s laws apply to disputes.'
    },
    {
      id: 'age', title: 'Age requirements', severity: 'Low', priority: 11,
      patterns: [
        { all: [r('\\b(at least|minimum age of|older than|over the age of|no younger than|aged?)\\s+(the age of\\s+)?(\\d{1,2}|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|twenty[- ]one)\\b(?!\\s*(days?|hours?|months?|times|characters|percent|%|dollars|usd|\\$))'), r('\\b(years?|old|age|minors?|child\\w*|adult|eligib\\w+|you must be)\\b')] },
        { all: [r('\\b(under|below|less than)\\s+(the age of\\s+)?(\\d{1,2}|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)\\b(?!\\s*(days?|hours?|months?|times))'), r('\\b(years?|old|age|minors?|child\\w*|use|service|account|may not|must not)\\b')] },
        { all: [r('\\b(\\d{1,2}|thirteen|sixteen|eighteen)\\s+(years|yrs)\\s+(old|of age)\\b')] },
        { all: [r('\\bage of (majority|consent)\\b')] },
        { all: [r('\\bminors?\\b.{0,80}\\b(may not|must not|not permitted|not allowed|parent|guardian|consent)\\b')] },
        { all: [r('\\bparent(al)? (consent|or (legal )?guardian)\\b')] }
      ],
      exclude: [],
      explain: 'The service sets a minimum age, or says people under a certain age need a parent or guardian\'s permission. By agreeing you are stating that you meet the requirement. If you or someone in your household does not, do not accept the terms.',
      line: 'There is a minimum age to use the service.'
    },
    {
      id: 'tracking_cookies', title: 'Tracking and cookies', severity: 'Low', priority: 12,
      patterns: [
        { all: [r('\\btracking (technolog\\w+|tools?|pixels?|cookies?|devices?)\\b')], severity: 'Medium', line: 'They track your activity, including for targeted ads.' },
        { all: [r('\\b(web beacons?|pixel tags?|tracking pixels?|device fingerprint\\w*|browser fingerprint\\w*|fingerprinting|advertising (id|identifier)s?)\\b')], severity: 'Medium', line: 'They track your activity, including for targeted ads.' },
        { all: [r('\\b(interest[- ]based|behaviou?ral|targeted|personali[sz]ed|tailored)\\s+(advertis\\w+|ads)\\b')], severity: 'Medium', line: 'They track your activity, including for targeted ads.' },
        { all: [r('\\btrack\\w*\\b.{0,80}\\b(you|your|users?|visitors?)\\b.{0,80}\\b(across|online|browsing|activity|behaviou?r|websites|sites|devices|usage)\\b')], severity: 'Medium', line: 'They track your activity, including for targeted ads.' },
        { all: [r('\\b(third[- ]party|advertising|marketing|analytics) cookies\\b')], severity: 'Medium', line: 'They track your activity, including for targeted ads.' },
        { all: [r('\\bcookies?\\b')], severity: 'Low' },
        { all: [r('\\b(analytics|local storage|session storage)\\b'), r('\\b(we|our|use|uses|using|collect|collects)\\b')], severity: 'Low' }
      ],
      exclude: [r("\\b(do not|does not|don't|doesn't|will not|won't|never)\\s+(\\w+\\s+){0,3}(use cookies|use any cookies|track|use tracking|use third[- ]party cookies)\\b")],
      explain: 'The service (or companies it works with) may use cookies and similar technologies to remember you, measure usage, and sometimes to follow your activity across sites or build a profile for advertising. Plain "session" cookies are usually minor; tracking for advertising is more of a privacy concern. Your browser settings can limit cookies.',
      line: 'They use cookies and similar tools to see how you use the service.'
    }
  ];

  var SEVERITIES = ['High', 'Medium', 'Low'];
  var SEVERITY_RANK = { High: 0, Medium: 1, Low: 2 };

  /*
   * One item per distinct point. These rules describe the same thing (how disputes with the company are settled), so
   * they are shown as ONE line, built from the parts that were actually found. Page text is never put in the line.
   */
  var GROUPS = [
    {
      id: 'disputes', title: 'How disputes are settled', members: ['arbitration', 'class_action', 'jury_waiver'], priority: 1,
      line: function (has, optOut) {
        var arb = !!has.arbitration, cls = !!has.class_action, jury = !!has.jury_waiver, s;
        if (arb && cls && jury) s = 'Disputes go to private arbitration: no court, no jury, and no class action lawsuits.';
        else if (arb && cls) s = "Disputes go to private arbitration, and you can't join a class action lawsuit.";
        else if (arb && jury) s = 'Disputes go to private arbitration, and you give up your right to a jury trial.';
        else if (cls && jury) s = "You can't sue them in a class action lawsuit, and you give up your right to a jury trial.";
        else if (arb) s = 'Disputes go to private arbitration instead of a court.';
        else if (cls) s = "You can't sue them in a class action lawsuit.";
        else s = 'You give up your right to a jury trial.';
        return arb && optOut ? s + ' You may be able to opt out of arbitration.' : s;
      }
    }
  ];

  /*
   * Context matrix: how the kind of service changes how much a finding matters.
   * shift: +1 raises the severity one step (Low->Medium, Medium->High), -1 lowers it one step; it never leaves High..Low.
   * note: shown in small print so the adjustment is never silent.
   * These are judgement calls, not legal facts. Anything not listed is not adjusted. A lawyer should review them.
   * Context types: news_media, shopping, social, finance, software, other (see core/context.js).
   */
  var CONTEXT_MATRIX = {
    liability_disclaimer: {
      news_media: { shift: -1, note: 'Routine for a news or media site, so shown as a lower concern.' },
      shopping: { shift: 1, note: 'Matters more when you are paying for goods or services.' },
      finance: { shift: 1, note: 'Matters more when your money is involved.' }
    },
    auto_renewal: {
      software: { shift: 1, note: 'Matters more for subscriptions and apps.' }
    },
    user_content_license: {
      social: { shift: 1, note: 'Matters more on a platform where you post your own content.' }
    },
    data_sharing: {
      finance: { shift: 1, note: 'Matters more for financial data.' }
    },
    termination: {
      finance: { shift: 1, note: 'Matters more when an account holds your money.' },
      news_media: { shift: -1, note: 'Losing access matters less on a news or media site.' }
    },
    tracking_cookies: {
      social: { shift: 1, note: 'Matters more on a platform that learns who you are and what you share.' }
    }
  };

  /*
   * CSO floor: the service type may RAISE these, and may lower them, but never below Medium. A forced-arbitration /
   * class-action / jury-waiver clause, a sale or sharing of your data, and a broad licence over your content matter
   * whatever the site is (a page that merely looks like a news site must not hide them). The floor only stops a context
   * shift from pushing a finding under Medium; a rule whose own pattern says Low (for example "shared with service
   * providers that run the service") stays Low.
   */
  var SEVERITY_FLOOR = {
    arbitration: 'Medium', class_action: 'Medium', jury_waiver: 'Medium', data_sharing: 'Medium', user_content_license: 'Medium'
  };

  return {
    RULES: RULES,
    SEVERITY_FLOOR: SEVERITY_FLOOR,
    SEVERITIES: SEVERITIES,
    SEVERITY_RANK: SEVERITY_RANK,
    GROUPS: GROUPS,
    CONTEXT_MATRIX: CONTEXT_MATRIX,
    NOTICE: 'Informational, not legal advice. This is an automatic scan done on this device with fixed rules (no AI, nothing is sent anywhere). It can miss things or misread them. Read the full terms, and talk to a lawyer if the decision matters.'
  };
});

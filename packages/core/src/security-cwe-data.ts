import type { SecuritySeverity } from './types.js';

export interface CweEntry {
  id: string;
  name: string;
  owaspCategory?: string;
  severity: SecuritySeverity;
  keywords: string[];
  remediation: string;
}

export const CWE_DATABASE: CweEntry[] = [
  {
    id: 'CWE-79',
    name: 'Cross-site Scripting (XSS)',
    owaspCategory: 'A7:2017 XSS',
    severity: 'P1',
    keywords: [
      'xss',
      'cross-site scripting',
      'innerhtml',
      'dangerouslysetinnerhtml',
      'document.write',
      'eval(',
      'script injection',
    ],
    remediation:
      'Sanitize and encode all user-controlled data before rendering. Use Content Security Policy (CSP). Prefer textContent over innerHTML.',
  },
  {
    id: 'CWE-89',
    name: 'SQL Injection',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P0',
    keywords: [
      'sql injection',
      'sqli',
      'raw sql',
      'string concatenation',
      'query interpolation',
      'unsanitized input',
      'execute(',
      'raw query',
    ],
    remediation:
      'Use parameterized queries or prepared statements. Never concatenate user input into SQL strings. Use an ORM with parameterization.',
  },
  {
    id: 'CWE-78',
    name: 'OS Command Injection',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P0',
    keywords: [
      'command injection',
      'os injection',
      'exec(',
      'spawn(',
      'shell injection',
      'child_process',
      'execsync',
      'system(',
    ],
    remediation:
      'Avoid passing user input to shell commands. If necessary, use parameterized APIs (e.g., execFile instead of exec). Validate and allowlist all inputs.',
  },
  {
    id: 'CWE-22',
    name: 'Path Traversal',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'path traversal',
      'directory traversal',
      '../',
      '..\\',
      'file inclusion',
      'arbitrary file read',
      'local file inclusion',
    ],
    remediation:
      'Validate and normalize file paths. Use path.resolve() and verify the result starts with the expected base directory. Allowlist permitted file locations.',
  },
  {
    id: 'CWE-352',
    name: 'Cross-Site Request Forgery (CSRF)',
    owaspCategory: 'A8:2017 CSRF',
    severity: 'P1',
    keywords: [
      'csrf',
      'cross-site request forgery',
      'missing csrf token',
      'state-changing request',
      'same-site cookie',
    ],
    remediation:
      'Implement CSRF tokens for all state-changing requests. Use SameSite=Strict or SameSite=Lax cookies. Validate Origin/Referer headers.',
  },
  {
    id: 'CWE-918',
    name: 'Server-Side Request Forgery (SSRF)',
    owaspCategory: 'A10:2021 SSRF',
    severity: 'P0',
    keywords: [
      'ssrf',
      'server-side request forgery',
      'fetch(url',
      'http.get(url',
      'axios.get(url',
      'unvalidated url',
      'internal network',
    ],
    remediation:
      'Validate and allowlist all URLs before making outbound requests. Block requests to internal IP ranges. Use a dedicated HTTP proxy that enforces allowlists.',
  },
  {
    id: 'CWE-502',
    name: 'Deserialization of Untrusted Data',
    owaspCategory: 'A8:2017 Insecure Deserialization',
    severity: 'P0',
    keywords: [
      'deserialization',
      'deserialize',
      'unserialize',
      'pickle.loads',
      'json.parse untrusted',
      'yaml.load(',
      'eval deserialization',
    ],
    remediation:
      'Never deserialize untrusted data. Use safe deserialization with schema validation. Prefer JSON with strict schema validation over YAML or pickle.',
  },
  {
    id: 'CWE-287',
    name: 'Improper Authentication',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P0',
    keywords: [
      'authentication bypass',
      'improper authentication',
      'weak authentication',
      'missing password check',
      'token validation',
    ],
    remediation:
      'Implement strong authentication with rate limiting. Use verified libraries for auth flows. Enforce multi-factor authentication for sensitive operations.',
  },
  {
    id: 'CWE-862',
    name: 'Missing Authorization',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P0',
    keywords: [
      'missing authorization',
      'no auth check',
      'unauthenticated endpoint',
      'authorization missing',
      'access control missing',
    ],
    remediation:
      'Add authorization checks to all routes and functions that access sensitive data or operations. Apply principle of least privilege.',
  },
  {
    id: 'CWE-863',
    name: 'Incorrect Authorization',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P0',
    keywords: [
      'incorrect authorization',
      'wrong permission',
      'privilege escalation',
      'role bypass',
      'unauthorized access',
    ],
    remediation:
      'Audit all authorization logic. Use role-based access control (RBAC) with explicit deny-by-default. Log all authorization failures.',
  },
  {
    id: 'CWE-306',
    name: 'Missing Authentication for Critical Function',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P0',
    keywords: [
      'missing auth',
      'no authentication',
      'critical function unprotected',
      'admin without auth',
      'public admin endpoint',
    ],
    remediation:
      'Require authentication for all critical operations. Implement middleware-level auth checks. Use authentication guards on all sensitive routes.',
  },
  {
    id: 'CWE-798',
    name: 'Hardcoded Credentials',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P0',
    keywords: [
      'hardcoded credential',
      'hardcoded password',
      'hardcoded secret',
      'hardcoded token',
      'hardcoded api key',
      'password =',
      'secret =',
    ],
    remediation:
      'Remove all hardcoded credentials. Use environment variables or a secrets manager (HashiCorp Vault, AWS Secrets Manager). Rotate any exposed credentials immediately.',
  },
  {
    id: 'CWE-312',
    name: 'Cleartext Storage of Sensitive Information',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: [
      'cleartext storage',
      'plaintext password',
      'unencrypted storage',
      'store password',
      'password in database unencrypted',
    ],
    remediation:
      'Hash passwords with bcrypt, scrypt, or argon2. Encrypt sensitive data at rest using AES-256. Never store plaintext passwords.',
  },
  {
    id: 'CWE-319',
    name: 'Cleartext Transmission of Sensitive Information',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: [
      'http://',
      'cleartext transmission',
      'unencrypted transmission',
      'plaintext transmission',
      'no tls',
      'no ssl',
    ],
    remediation:
      'Use HTTPS/TLS for all sensitive data transmission. Enforce HSTS. Redirect HTTP to HTTPS. Use TLS 1.2 or higher.',
  },
  {
    id: 'CWE-327',
    name: 'Use of Broken or Risky Cryptographic Algorithm',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: [
      'md5',
      'sha1',
      'des ',
      'rc4',
      'broken crypto',
      'weak encryption',
      'weak hash',
      'ecb mode',
      'deprecated cipher',
    ],
    remediation:
      'Replace MD5/SHA1 with SHA-256 or higher. Use AES-GCM for encryption. Avoid ECB mode. Use established libraries (libsodium, Web Crypto API).',
  },
  {
    id: 'CWE-330',
    name: 'Use of Insufficiently Random Values',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: [
      'math.random',
      'pseudo-random',
      'weak random',
      'predictable token',
      'insufficient entropy',
      'rand()',
      'random() token',
    ],
    remediation:
      'Use cryptographically secure random generators: crypto.randomBytes() in Node.js, crypto.getRandomValues() in browsers. Never use Math.random() for security tokens.',
  },
  {
    id: 'CWE-611',
    name: 'Improper Restriction of XML External Entity Reference (XXE)',
    owaspCategory: 'A4:2017 XXE',
    severity: 'P1',
    keywords: ['xxe', 'xml external entity', 'xml injection', 'external entity', 'doctype', 'entity declaration'],
    remediation:
      'Disable external entity processing in XML parsers. Use JSON instead of XML where possible. Validate XML against a strict schema before parsing.',
  },
  {
    id: 'CWE-200',
    name: 'Exposure of Sensitive Information to Unauthorized Actor',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P2',
    keywords: [
      'information disclosure',
      'sensitive data exposure',
      'data leak',
      'information leakage',
      'expose pii',
      'leaked data',
    ],
    remediation:
      'Audit all API responses for unnecessary sensitive data. Implement field-level access control. Log and alert on sensitive data access patterns.',
  },
  {
    id: 'CWE-209',
    name: 'Generation of Error Message Containing Sensitive Information',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P2',
    keywords: [
      'error message leak',
      'stack trace exposed',
      'verbose error',
      'error information disclosure',
      'exception exposed',
      'internal error revealed',
    ],
    remediation:
      'Return generic error messages to users. Log detailed errors server-side only. Use error codes instead of error messages in API responses.',
  },
  {
    id: 'CWE-434',
    name: 'Unrestricted Upload of File with Dangerous Type',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P1',
    keywords: [
      'file upload',
      'unrestricted upload',
      'dangerous file type',
      'file type validation',
      'mime type bypass',
      'upload bypass',
    ],
    remediation:
      'Validate file type by content (magic bytes), not by extension or MIME type header. Allowlist permitted file types. Store uploads outside webroot. Scan for malware.',
  },
  {
    id: 'CWE-601',
    name: 'URL Redirection to Untrusted Site (Open Redirect)',
    owaspCategory: 'A10:2013 Unvalidated Redirects',
    severity: 'P2',
    keywords: ['open redirect', 'url redirect', 'redirect to', 'unvalidated redirect', 'redirect url parameter'],
    remediation:
      'Validate all redirect URLs against an allowlist of trusted domains. Use relative URLs for internal redirects. Warn users before redirecting to external sites.',
  },
  {
    id: 'CWE-639',
    name: 'Authorization Bypass Through User-Controlled Key (IDOR)',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'idor',
      'insecure direct object reference',
      'object reference',
      'sequential id',
      'predictable id',
      'object id without auth check',
    ],
    remediation:
      'Validate ownership or permissions for every object accessed via user-controlled identifiers. Use indirect references or UUIDs instead of sequential IDs.',
  },
  {
    id: 'CWE-94',
    name: 'Improper Control of Generation of Code (Code Injection)',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P0',
    keywords: [
      'code injection',
      'eval(',
      'new function(',
      'vm.runin',
      'dynamic code execution',
      'template injection',
      'ssti',
    ],
    remediation:
      'Avoid eval() and dynamic code execution. Use safe templating engines that auto-escape. Implement Content Security Policy to prevent code injection.',
  },
  {
    id: 'CWE-116',
    name: 'Improper Encoding or Escaping of Output',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P2',
    keywords: [
      'improper encoding',
      'missing escaping',
      'output encoding',
      'html encoding missing',
      'unescaped output',
      'injection due to missing escape',
    ],
    remediation:
      'Apply context-appropriate output encoding: HTML encoding for HTML context, URL encoding for URL context. Use templating engines that auto-escape.',
  },
  {
    id: 'CWE-290',
    name: 'Authentication Bypass by Spoofing',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P0',
    keywords: [
      'auth bypass',
      'ip spoofing',
      'header spoofing',
      'x-forwarded-for bypass',
      'authentication spoofing',
      'trust header',
    ],
    remediation:
      'Do not rely on spoofable headers (X-Forwarded-For) for authentication decisions without proper proxy configuration. Validate tokens cryptographically.',
  },
  {
    id: 'CWE-362',
    name: 'Race Condition (TOCTOU)',
    severity: 'P1',
    keywords: ['race condition', 'toctou', 'time of check', 'time of use', 'concurrent access', 'double-free', 'race'],
    remediation:
      'Use atomic operations for critical state transitions. Implement proper locking mechanisms. Use database transactions for consistency.',
  },
  {
    id: 'CWE-190',
    name: 'Integer Overflow or Wraparound',
    severity: 'P1',
    keywords: ['integer overflow', 'integer wraparound', 'arithmetic overflow', 'numeric overflow', 'size overflow'],
    remediation:
      'Validate numeric inputs for reasonable ranges. Use BigInt for large integers. Add explicit overflow checks for arithmetic operations.',
  },
  {
    id: 'CWE-120',
    name: 'Buffer Copy without Checking Size of Input (Buffer Overflow)',
    severity: 'P0',
    keywords: [
      'buffer overflow',
      'buffer copy',
      'strcpy',
      'sprintf without limit',
      'buffer overrun',
      'heap overflow',
      'stack overflow',
    ],
    remediation:
      'Use bounds-checked string functions. Validate buffer sizes before copy operations. Use memory-safe languages or safe wrappers.',
  },
  {
    id: 'CWE-476',
    name: 'NULL Pointer Dereference',
    severity: 'P2',
    keywords: ['null dereference', 'null pointer', 'null reference', 'undefined dereference', 'nullable without check'],
    remediation:
      'Add null checks before dereferencing pointers or object properties. Use optional chaining (?.) and nullish coalescing (??) where appropriate.',
  },
  {
    id: 'CWE-416',
    name: 'Use After Free',
    severity: 'P0',
    keywords: ['use after free', 'dangling pointer', 'freed memory access', 'double free', 'memory corruption'],
    remediation:
      'Set pointers to null after freeing. Use smart pointers or garbage-collected languages. Implement memory sanitizers in CI/CD.',
  },
  {
    id: 'CWE-134',
    name: 'Use of Externally-Controlled Format String',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P1',
    keywords: [
      'format string',
      'printf(user',
      'sprintf(user',
      'fprintf(user',
      'user-controlled format',
      'format injection',
    ],
    remediation:
      'Never use user input as a format string. Use constant format strings. Apply input validation before passing to formatting functions.',
  },
  {
    id: 'CWE-732',
    name: 'Incorrect Permission Assignment for Critical Resource',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'permission assignment',
      'file permission',
      'chmod 777',
      'world writable',
      'overly permissive',
      'incorrect permissions',
    ],
    remediation:
      'Apply principle of least privilege for file and resource permissions. Audit permission assignments. Use 0600 for secrets, 0644 for public files.',
  },
  {
    id: 'CWE-400',
    name: 'Uncontrolled Resource Consumption (DoS)',
    owaspCategory: 'A6:2021 Vulnerable and Outdated Components',
    severity: 'P2',
    keywords: [
      'denial of service',
      'dos vulnerability',
      'resource exhaustion',
      'uncontrolled loop',
      'no rate limit',
      'missing rate limiting',
      'rate limit',
    ],
    remediation:
      'Implement rate limiting on all public endpoints. Add request size limits. Use circuit breakers. Set timeouts on all external calls.',
  },
  {
    id: 'CWE-942',
    name: 'Permissive Cross-domain Policy with Untrusted Domains (CORS)',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'cors misconfiguration',
      'cors *',
      'access-control-allow-origin *',
      'cors any origin',
      'permissive cors',
      'cors policy',
    ],
    remediation:
      'Specify explicit allowed origins for CORS. Never use wildcard (*) for CORS with credentials. Validate Origin header against an allowlist.',
  },
  {
    id: 'CWE-613',
    name: 'Insufficient Session Expiration',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P2',
    keywords: [
      'session expiration',
      'no session timeout',
      'token expiry',
      'long-lived token',
      'session not invalidated',
      'token without expiry',
    ],
    remediation:
      'Set appropriate session timeouts. Implement token expiration for JWTs. Provide secure logout that invalidates server-side sessions.',
  },
  {
    id: 'CWE-614',
    name: 'Sensitive Cookie in HTTPS Session Without Secure Attribute',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P2',
    keywords: [
      'cookie secure flag',
      'missing secure flag',
      'httponly missing',
      'cookie without secure',
      'samesite missing',
    ],
    remediation:
      'Set Secure and HttpOnly flags on all session cookies. Use SameSite=Strict or Lax. Prefix sensitive cookie names with __Secure- or __Host-.',
  },
  {
    id: 'CWE-770',
    name: 'Allocation of Resources Without Limits or Throttling',
    owaspCategory: 'A6:2021 Vulnerable and Outdated Components',
    severity: 'P2',
    keywords: [
      'no resource limit',
      'unlimited allocation',
      'no throttle',
      'unconstrained memory',
      'no size limit',
      'unlimited file size',
    ],
    remediation:
      'Set resource limits (max file size, max request body). Implement throttling and back-pressure. Monitor resource usage and alert on anomalies.',
  },
  {
    id: 'CWE-776',
    name: 'Improper Restriction of Recursive Entity References (Billion Laughs)',
    owaspCategory: 'A4:2017 XXE',
    severity: 'P1',
    keywords: ['billion laughs', 'xml bomb', 'recursive entity', 'entity expansion', 'xml dos'],
    remediation: 'Limit entity expansion depth and total entity count in XML parsers. Set a maximum recursion depth.',
  },
  {
    id: 'CWE-113',
    name: 'HTTP Header Injection',
    owaspCategory: 'A1:2017 Injection',
    severity: 'P1',
    keywords: ['http header injection', 'crlf injection', 'header splitting', 'response splitting'],
    remediation:
      'Sanitize inputs for \\r and \\n before including in HTTP headers. Use framework-provided header-setting APIs.',
  },
  {
    id: 'CWE-1021',
    name: 'Improper Restriction of Rendered UI Layers (Clickjacking)',
    owaspCategory: 'A6:2017 Security Misconfiguration',
    severity: 'P2',
    keywords: ['clickjacking', 'iframe embedding', 'missing x-frame-options', 'frame ancestor', 'ui redressing'],
    remediation:
      'Set X-Frame-Options: DENY or use Content-Security-Policy frame-ancestors directive. Implement frame-busting JavaScript as a defense-in-depth measure.',
  },
  {
    id: 'CWE-346',
    name: 'Origin Validation Error',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'origin validation',
      'missing origin check',
      'origin bypass',
      'postmessage without origin check',
      'cross-origin',
    ],
    remediation:
      'Validate message origin in postMessage handlers. Check Origin header server-side. Never trust client-supplied origin without cryptographic validation.',
  },
  {
    id: 'CWE-915',
    name: 'Improperly Controlled Modification of Dynamically-Determined Object Attributes (Mass Assignment)',
    owaspCategory: 'A5:2017 Broken Access Control',
    severity: 'P1',
    keywords: [
      'mass assignment',
      'over-posting',
      'parameter pollution',
      'object spread unfiltered',
      'body spread',
      'req.body spread',
    ],
    remediation:
      'Use explicit allowlists (DTO patterns) to filter request body properties. Never spread req.body directly onto model objects.',
  },
  {
    id: 'CWE-521',
    name: 'Weak Password Requirements',
    owaspCategory: 'A2:2017 Broken Authentication',
    severity: 'P2',
    keywords: [
      'weak password',
      'no password policy',
      'minimum password length',
      'password complexity',
      'password policy missing',
    ],
    remediation:
      'Enforce minimum 12-character passwords. Check against known breached password lists (Have I Been Pwned). Implement multi-factor authentication.',
  },
  {
    id: 'CWE-749',
    name: 'Exposed Dangerous Method or Function',
    owaspCategory: 'A6:2017 Security Misconfiguration',
    severity: 'P1',
    keywords: [
      'exposed dangerous method',
      'debug endpoint',
      'admin endpoint exposed',
      'development endpoint',
      'exposed debug',
    ],
    remediation:
      'Remove or protect debug/admin endpoints behind strong authentication. Disable development-only features in production. Audit all exposed API endpoints.',
  },
  {
    id: 'CWE-311',
    name: 'Missing Encryption of Sensitive Data',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: [
      'missing encryption',
      'unencrypted sensitive',
      'no encryption',
      'plaintext pii',
      'unencrypted pii',
      'unencrypted health',
    ],
    remediation:
      'Encrypt all PII, PHI, and financial data at rest using AES-256-GCM. Use hardware security modules (HSMs) for key management.',
  },
  {
    id: 'CWE-338',
    name: 'Use of Cryptographically Weak Pseudo-Random Number Generator',
    owaspCategory: 'A3:2017 Sensitive Data Exposure',
    severity: 'P1',
    keywords: ['weak prng', 'weak random number', 'seeded random', 'predictable random', 'insecure random'],
    remediation:
      'Use OS-provided CSPRNG: crypto.randomBytes() in Node.js. Never seed a PRNG with predictable values (timestamps, process IDs).',
  },
];

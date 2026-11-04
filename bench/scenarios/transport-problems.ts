import type { BenchRequest } from '../support/server.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

export default defineScenario({
  name: 'transport-problems',
  summary: 'HTTPS problems the tuned site does not have: an expired certificate on www, a temporary http upgrade and no Strict-Transport-Security.',
  hosts: studioHosts,
  expiredCertificates: ['www.vellora.example'],
  build: context => {
    const site = studio(context);
    delete site.pageHeaders['strict-transport-security'];
    const upgrade = (request: BenchRequest) => ({ status: 302, headers: { location: site.url(request.path) }, body: '' });
    return { origins: { ...site.origins(), 'http://vellora.example': upgrade, 'http://www.vellora.example': upgrade }, url: site.url('/en/') };
  },
  mustFail: [
    { rule: 'tech-tls-certificate-valid', severity: 'critical', reason: 'expired' },
    { rule: 'tech-http-to-https-redirect', severity: 'low', reason: 'temporary-redirect' },
    { rule: 'tech-hsts-header', severity: 'info', reason: 'missing' },
  ],
  mustNotFail: [
    // The audited host itself has a valid certificate and serves every page over HTTPS.
    'tech-https-final-url', 'tech-https-to-http-downgrade',
  ],
});

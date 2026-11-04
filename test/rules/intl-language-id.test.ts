import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { closelyRelated, detectLanguage, minimumWords, tokenize } from '../../src/analyze/language.ts';
import { samples } from './intl-language-samples.ts';

const heldOut: ReadonlyArray<readonly [string, string]> = [
  ['ca', "Aquesta política de privacitat explica com recollim i tractem les dades personals dels usuaris del lloc web. Pots exercir els teus drets d'accés, rectificació i supressió escrivint-nos a l'adreça indicada al final d'aquesta pàgina, i et respondrem en el termini d'un mes."],
  ['ca', 'La botiga obre cada dia de deu del matí a vuit del vespre, excepte els diumenges a la tarda. Tenim aparcament gratuït per als clients i servei de lliurament a domicili a tota la parròquia. Si vols un pressupost, omple el formulari i et trucarem aviat.'],
  ['es', 'Esta política de privacidad explica cómo recogemos y tratamos los datos personales de los usuarios del sitio web. Puedes ejercer tus derechos de acceso, rectificación y supresión escribiéndonos a la dirección indicada al final de esta página, y te responderemos en el plazo de un mes.'],
  ['es', 'La tienda abre todos los días de diez de la mañana a ocho de la tarde, excepto los domingos por la tarde. Tenemos aparcamiento gratuito para los clientes y servicio de entrega a domicilio en toda la ciudad. Si quieres un presupuesto, rellena el formulario y te llamaremos pronto.'],
  ['pt', 'Esta política de privacidade explica como recolhemos e tratamos os dados pessoais dos utilizadores do sítio. Pode exercer os seus direitos de acesso, retificação e eliminação escrevendo-nos para o endereço indicado no fim desta página, e responderemos no prazo de um mês.'],
  ['fr', "Cette politique de confidentialité explique comment nous collectons et traitons les données personnelles des utilisateurs du site. Vous pouvez exercer vos droits d'accès, de rectification et de suppression en nous écrivant à l'adresse indiquée en bas de cette page, et nous vous répondrons sous un mois."],
  ['it', "Questa informativa sulla privacy spiega come raccogliamo e trattiamo i dati personali degli utenti del sito. Puoi esercitare i tuoi diritti di accesso, rettifica e cancellazione scrivendoci all'indirizzo indicato in fondo a questa pagina, e ti risponderemo entro un mese."],
  ['en', 'This privacy policy explains how we collect and process the personal data of users of the website. You can exercise your rights of access, rectification and erasure by writing to the address shown at the bottom of this page, and we will reply within one month.'],
  ['de', 'Diese Datenschutzerklärung erklärt, wie wir personenbezogene Daten der Nutzer der Website erheben und verarbeiten. Sie können Ihre Rechte auf Auskunft, Berichtigung und Löschung ausüben, indem Sie uns an die unten auf dieser Seite angegebene Adresse schreiben.'],
  ['oc', "Aquesta politica de confidencialitat explica cossí recampam e tractam las donadas personalas dels utilizaires del site. Podètz exercir vòstres dreches d'accès, de rectificacion e de supression en nos escrivent a l'adreça indicada al pè d'aquesta pagina, e vos respondrem dins un mes."],
  ['oc', "Era Val d'Aran ei un territòri occitan des Pirenèus. Eth aranés ei era lengua pròpria deth parçan e se parla en toti es pòbles dera val. Es escòles ensenhen en aranés e era administracion ac utilize cada dia damb es vesins e es visitaires."],
];

describe('language identifier', () => {
  test('identifies every labelled snippet with high confidence', () => {
    for (const sample of samples) {
      const guess = detectLanguage(sample.text);
      assert.equal(guess.language, sample.language, `${sample.language}: ${sample.text.slice(0, 40)}`);
      assert.ok(guess.confidence >= 0.9, `${sample.language} confidence ${guess.confidence}`);
    }
  });

  test('identifies snippets on other topics that were not used to set its weights', () => {
    for (const [language, text] of heldOut) assert.equal(detectLanguage(text).language, language, text.slice(0, 40));
  });

  test('tells Catalan, Spanish and Occitan apart on parallel text', () => {
    const parallel = samples.filter(sample => ['ca', 'es', 'oc'].includes(sample.language));
    for (const sample of parallel) {
      const guess = detectLanguage(sample.text);
      assert.equal(guess.language, sample.language);
      assert.ok(['ca', 'es', 'oc', 'it', 'pt', 'fr'].includes(guess.runnerUp!));
    }
  });

  test('is undetermined below the word minimum', () => {
    const guess = detectLanguage('Benvinguts a la nostra botiga de roba i complements.');
    assert.equal(guess.language, 'und');
    assert.equal(guess.confidence, 0);
    assert.ok(guess.words < minimumWords);
  });

  test('is undetermined for languages outside its set', () => {
    const dutch = 'Wij zijn een ontwerpstudio die samenwerkt met kleine en middelgrote bedrijven. We luisteren graag naar onze klanten, begrijpen wat ze nodig hebben en stellen eenvoudige oplossingen voor die werken. Elk project is anders, maar we beginnen altijd met een gesprek.';
    assert.equal(detectLanguage(dutch).language, 'und');
  });

  test('keeps confidence below 0.9 for a half-and-half text', () => {
    const mixed = 'We are a design studio that works with small businesses and we like to listen to our clients. Somos un estudio de diseño que trabaja con pequeñas empresas y nos gusta escuchar a los clientes y entender qué necesitan.';
    assert.ok(detectLanguage(mixed).confidence < 0.9);
  });

  test('keeps elisions, clitics and the Catalan middle dot', () => {
    assert.deepEqual(tokenize("L'equip d'aquí: col·laboració, col.lecció i dóna'ls-ho"), ["l'", 'equip', "d'", 'aquí', 'col·laboració', 'col·lecció', 'i', 'dóna', "'ls", 'ho']);
    assert.deepEqual(tokenize("We don't know it's late"), ['we', "don't", 'know', "it's", 'late']);
  });

  test('names the pairs that need a second look', () => {
    assert.equal(closelyRelated('ca', 'es'), true);
    assert.equal(closelyRelated('oc', 'ca'), true);
    assert.equal(closelyRelated('en', 'de'), false);
  });
});

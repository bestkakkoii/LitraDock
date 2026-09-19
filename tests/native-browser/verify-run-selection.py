"""Independent readers for the labeled PostgreSQL durable selection fixture.

The fixture saves five records, explicitly excludes record one, and exports
records two through five at revision 14. These literal expectations come from
the deliberate actions, not from the encoder or a generated expected file.
No source transport, original-file claim, or live provider capacity is tested.
"""
import argparse
import copy
import csv
import importlib.util
import json
import pathlib
import re
import sys

if sys.flags.optimize:
    raise SystemExit('Optimized Python disables acceptance assertions.')


def module(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


structured = module('verify-structured')
workbook = module('verify-workbook')
EXTRA = ['Export scope', 'Selection revision', 'Saved record count']
OUTCOME = ['Source outcome', 'Source outcome detail', 'Next action', 'Outcome evidence', 'Source observed at', 'Outcome format']
CSV_HEADERS = workbook.HEADERS[:14] + OUTCOME + ['Search Run ID', 'Batch ID'] + EXTRA
BOOK_HEADERS = workbook.HEADERS[:22] + EXTRA + OUTCOME
SELECTED = ['LD-' + str(n).zfill(32) for n in range(2, 6)]


def expected_row(n, run):
    row = dict.fromkeys(set(CSV_HEADERS + BOOK_HEADERS), '')
    row.update({'Search ID': 'LD-' + str(n).zfill(32), 'Title': f'SYNTHETIC ONLY α 中文 record {n}',
                'Authors': 'Synthetic author', 'Year': '2026', 'PMID': str(990000000 + n),
                'PMCID': 'PMC' + str(990000000 + n), 'DOI': f'10.0000/synthetic.{n}',
                'PubMed URL': f'https://pubmed.ncbi.nlm.nih.gov/{990000000 + n}/',
                'PMC URL': f'https://pmc.ncbi.nlm.nih.gov/articles/PMC{990000000 + n}/',
                'DOI URL': f'https://doi.org/10.0000/synthetic.{n}', 'DOI link status': 'available',
                'Search Run ID': run, 'Export scope': 'selected_saved_records',
                'Selection revision': '14', 'Saved record count': '5', 'Source outcome': 'not_checked',
                'Source outcome detail': 'Saved metadata does not establish whether a permitted original is available.',
                'Next action': 'Open the article source links or explicitly request a supported original.',
                'Outcome evidence': 'no_saved_outcome', 'Outcome format': 'pdf'})
    return row


def check_document(document):
    structured.validate(document, True, expected_selection='selected_saved_records')
    scope = document['scope']
    run = scope['runId']
    assert re.fullmatch(r'RUN-[a-f0-9]{32}', run)
    assert scope['selectionRevision'] == 14 and scope['savedRecords'] == 5
    assert document['counts'] == {'exportedRecords': 4, 'scopeRecords': 4, 'providerMatches': 10000, 'retrievedRecords': 5}
    assert [r['searchId'] for r in document['records']] == SELECTED
    assert len(document['queryContexts']) == 1
    query = document['queryContexts'][0]
    assert query['runId'] == run and query['query'] == 'SYNTHETIC ONLY query'
    assert query['providerMatches'] == 10000 and query['retrievedRecords'] == 5 and not query['retrievalComplete']
    for n, record in enumerate(document['records'], 2):
        row = expected_row(n, run)
        assert record['runIds'] == [run] and record['originals'] == []
        assert record['identifiers'] == {'pmid': row['PMID'], 'pmcid': row['PMCID'], 'doi': row['DOI']}
        assert record['publication']['title'] == row['Title']
        assert record['publication']['authors'] == row['Authors'] and record['publication']['year'] == '2026'
        assert record['sourceLinks'] == {'pubmed': row['PubMed URL'], 'pmc': row['PMC URL'], 'doi': row['DOI URL'], 'doiLinkState': 'available'}
        assert record['sourceOutcome']['status'] == 'not_checked' and record['sourceOutcome']['evidence'] == 'no_saved_outcome'
    return run


def check_csv(rows, run):
    assert list(rows[0]) == CSV_HEADERS and len(rows) == 4
    for n, row in enumerate(rows, 2):
        assert row == {key: expected_row(n, run)[key] for key in CSV_HEADERS}


def rejected(check, value):
    try:
        check(value)
    except (AssertionError, ValueError, KeyError, TypeError):
        return True
    raise AssertionError('Mutation survived independent reader')


def verify(directory):
    documents = [structured.load(directory / ('SYNTHETIC-selected.' + suffix), True, 'selected_saved_records') for suffix in ('json', 'jsonl')]
    run = check_document(documents[0])
    assert check_document(documents[1]) == run
    # Generation timestamps/type can differ between independent HTTP exports.
    for key in ('scope', 'counts', 'queryContexts', 'records'):
        assert documents[0][key] == documents[1][key]
    with (directory / 'SYNTHETIC-selected.csv').open(encoding='utf-8', newline='') as source:
        rows = list(csv.DictReader(source))
    check_csv(rows, run)
    expected = {'rows': 5, 'cells': {}, 'hyperlinks': {}}
    from openpyxl.utils import get_column_letter
    for n in range(2, 6):
        row = expected_row(n, run)
        for column, header in enumerate(BOOK_HEADERS, 1):
            expected['cells'][get_column_letter(column) + str(n)] = row[header]
        for column, header in (('H', 'PubMed URL'), ('I', 'PMC URL'), ('J', 'DOI URL')):
            expected['hyperlinks'][column + str(n)] = row[header]
    file = directory / 'SYNTHETIC-selected.xlsx'
    result = workbook.verify(file, expected, BOOK_HEADERS)
    result['workbook_mutations'] = workbook.controls(file, expected, BOOK_HEADERS)
    for key, value in (('selection', 'all_saved_scope'), ('selectionRevision', 13), ('savedRecords', 4), ('runId', 'RUN-foreign')):
        changed = copy.deepcopy(documents[0]); changed['scope'][key] = value
        assert rejected(check_document, changed)
    for key, value in (('searchId', 'LD-' + '1'.zfill(32)), ('runIds', ['RUN-foreign'])):
        changed = copy.deepcopy(documents[0]); changed['records'][0][key] = value
        assert rejected(check_document, changed)
    changed = copy.deepcopy(documents[0]); changed['records'].reverse()
    assert rejected(check_document, changed)
    for key, value in (('Search ID', 'LD-' + '1'.zfill(32)), ('Export scope', 'all_saved_scope'), ('Selection revision', '13'), ('PMID', '2')):
        changed = copy.deepcopy(rows); changed[0][key] = value
        assert rejected(lambda value: check_csv(value, run), changed)
    result.update(scope='SYNTHETIC ONLY', selected=4, saved=5, provider_matches=10000, live_provider_capacity=False,
                  structured_mutations=7, csv_mutations=4, zero_source_requests=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=pathlib.Path)
    print(json.dumps(verify(parser.parse_args().directory), sort_keys=True))

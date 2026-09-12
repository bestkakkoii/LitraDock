"""Independent consumers of actual C# RIS/BibTeX projections; not a serializer roundtrip."""
import json
import sys
from pathlib import Path
import importlib.metadata
import bibtexparser
import rispy
from pylatexenc.latex2text import LatexNodes2Text

root=Path(sys.argv[1]);names=[]
def check(value,name):
    if not value:raise AssertionError(name)
    names.append(name);print('PASS '+name)
csl=json.loads((root/'interchange.csl.json').read_text(encoding='utf-8'))
ris=rispy.loads((root/'interchange.ris').read_text(encoding='utf-8'))
bib=bibtexparser.parse_string((root/'interchange.bib').read_text(encoding='utf-8'))
check(len(ris)==1 and len(bib.entries)==1 and not bib.failed_blocks,'Independent parsers accept exactly one complete exported entry')
fields={key:field.value for key,field in bib.entries[0].fields_dict.items()}
check(ris[0]['id']==bib.entries[0].key==csl['id'],'Stable Search ID survives both independent citation parsers')
check(ris[0]['title']==csl['title'],'RIS Unicode and formula-like punctuation remain exact data')
check(LatexNodes2Text().latex_to_text(fields['title'])==csl['title'],'BibTeX escapes decode to original Unicode braces and reserved characters')
check(ris[0]['custom7']==fields['eid']==csl['number'] and not fields.get('pages'),'Article number never masquerades as page range')
check('Research Council' in ris[0]['authors'] and '{Research Council}' in fields['author'],'Corporate author grouping preserved for independent consumers')
check(fields['pmid']==csl['PMID'] and fields['pmcid']==csl['PMCID'] and fields['doi']==csl['DOI'],'BibTeX DOI PMID PMCID remain separate textual identifiers')
(root/'interchange-result.json').write_text(json.dumps({'checks':len(names),'names':names,'versions':{p:importlib.metadata.version(p) for p in ['bibtexparser','rispy','pylatexenc']}},indent=2),encoding='utf-8')

"""Independent PDF text/layout/raster checks using PyMuPDF, on generated synthetic documents only."""
import json
import unicodedata
from pathlib import Path
import sys
import pymupdf

root = Path(sys.argv[1]); checks=[]
def check(value, name):
    if not value: raise AssertionError(name)
    checks.append(name);print('PASS '+name)
for name in ['reading','html','abstract']:
    document = pymupdf.open(root / (name+'.pdf'))
    text='\n'.join(page.get_text() for page in document)
    check(document.page_count > 0, name+' PDF parsed independently')
    check(('Abstract Only' if name=='abstract' else 'Formatted Reading Copy') in text, name+' label visible in extracted PDF')
    if name=='reading':
        check(document.page_count>=4, 'Long table spans multiple actual PDF pages')
        for i in range(1,161): check(f'Exact observation {i}: 3.14159' in text,f'Table row {i} preserved')
        for expected in ['中文研究','Ελληνικά','Русский','Figure one caption.','Footnote retained.','References']:
            check(expected in text,'PDF content '+expected)
        check(any(link.get('uri')=='https://doi.org/10.1000/example' for page in document for link in page.get_links()),'Actual PDF external reference hyperlink')
        check('Derived page' in text,'Derived page numbers labelled separately')
        images=[pymupdf.Pixmap(document,image[0]) for page in document for image in page.get_images()]
        check(any(image.width==32 and image.height==16 and image.pixel(2,2)[:3]==(255,0,0) and image.pixel(30,2)[:3]==(0,0,255) for image in images),'Independent embedded figure dimensions and exact red/blue pixels')
        characters=[c for block in document[0].get_text('rawdict')['blocks'] if 'lines' in block for line in block['lines'] for span in line['spans'] for c in span['chars']]
        numerator=[c['bbox'] for c in characters if c['c']=='𝑎'];denominator=[c['bbox'] for c in characters if c['c']=='𝑏']
        check(any(a[1]<b[1] and abs(a[0]-b[0])<5 for a in numerator for b in denominator),'MathML fraction numerator is rendered above denominator')
    elif name=='html':
        check(all(x in text for x in ['Left source column','Right source column','Final retained paragraph.']), 'Both source columns retain semantic content')
        check('PRIVATE-CANARY' not in text and "fetch(" not in text,'No active source or private canary content in PDF')
    else: check('中文摘要' in text,'Abstract Unicode retained')
    for index in sorted({0,document.page_count//2,document.page_count-1}):
        document[index].get_pixmap(matrix=pymupdf.Matrix(1.3,1.3)).save(root/f'{name}-page-{index+1}.png')
    (root/(name+'-text.txt')).write_text(text,encoding='utf-8')
(root/'pdf-inspection.json').write_text(json.dumps({'version':pymupdf.__version__,'checks':len(checks),'names':checks},ensure_ascii=False,indent=2),encoding='utf-8')

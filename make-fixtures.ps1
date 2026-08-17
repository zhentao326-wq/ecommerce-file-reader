# make-fixtures.ps1 — 生成 ecommerce-file-reader 的测试样本文件
# 运行: pwsh -File make-fixtures.ps1   （输出到 ./fixtures/）
$ErrorActionPreference = 'Stop'

$script:Dir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $script:Dir | Out-Null

# ---------------------------------------------------------------- 字节工具
function Append-U8([System.Collections.Generic.List[byte]]$l, [int]$v) { $l.Add([byte]($v -band 0xFF)) }
function Append-U16([System.Collections.Generic.List[byte]]$l, [int]$v) { $l.Add([byte]($v -band 0xFF)); $l.Add([byte](($v -shr 8) -band 0xFF)) }
function Append-U32([System.Collections.Generic.List[byte]]$l, [long]$v) {
  for ($i = 0; $i -lt 4; $i++) { $l.Add([byte](($v -shr (8 * $i)) -band 0xFF)) }
}
function Append-Bytes([System.Collections.Generic.List[byte]]$l, [byte[]]$b) { foreach ($x in $b) { $l.Add($x) } }
function Append-Ieee64([System.Collections.Generic.List[byte]]$l, [double]$d) {
  $b = [System.BitConverter]::GetBytes([double]$d)
  foreach ($x in $b) { $l.Add($x) }
}
function Append-Ascii([System.Collections.Generic.List[byte]]$l, [string]$s) {
  Append-Bytes $l ([System.Text.Encoding]::ASCII.GetBytes($s))
}
function Set-U16BE([byte[]]$b, [int]$off, [int]$v) {
  $b[$off] = [byte](($v -shr 8) -band 0xFF); $b[$off + 1] = [byte]($v -band 0xFF)
}
function Set-U32BE([byte[]]$b, [int]$off, [long]$v) {
  $b[$off] = [byte](($v -shr 24) -band 0xFF); $b[$off + 1] = [byte](($v -shr 16) -band 0xFF)
  $b[$off + 2] = [byte](($v -shr 8) -band 0xFF);  $b[$off + 3] = [byte]($v -band 0xFF)
}
function Set-U32LE([byte[]]$b, [int]$off, [long]$v) {
  for ($i = 0; $i -lt 4; $i++) { $b[$off + $i] = [byte](($v -shr (8 * $i)) -band 0xFF) }
}
function Set-U16LE([byte[]]$b, [int]$off, [int]$v) {
  $b[$off] = [byte]($v -band 0xFF); $b[$off + 1] = [byte](($v -shr 8) -band 0xFF)
}

function Get-Crc32([byte[]]$data) {
  $table = New-Object 'long[]' 256
  for ($i = 0; $i -lt 256; $i++) {
    $c = [long]$i
    for ($k = 0; $k -lt 8; $k++) {
      if (($c -band 1) -ne 0) { $c = ([long]0xEDB88320 -bxor ($c -shr 1)) } else { $c = $c -shr 1 }
    }
    $table[$i] = $c
  }
  $crc = [long]0xFFFFFFFF
  foreach ($x in $data) {
    $idx = [int](($crc -band 0xFF) -bxor [long]$x)
    $crc = (($crc -shr 8) -bxor $table[$idx])
  }
  return (($crc -bxor [long]0xFFFFFFFF) -band [long]0xFFFFFFFF)
}

function Get-Adler32([byte[]]$data) {
  $a = 1; $b = 0
  foreach ($x in $data) {
    $a = ($a + $x) % 65521
    $b = ($b + $a) % 65521
  }
  return ((($b -shl 16) -bor $a) -band [long]0xFFFFFFFF)
}

function Compress-Deflate([byte[]]$data) {
  $ms = New-Object System.IO.MemoryStream
  $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $ds.Write($data, 0, $data.Length)
  $ds.Close()
  return $ms.ToArray()
}

# ---------------------------------------------------------------- PNG (120x80)
function New-Png([int]$w, [int]$h) {
  # 像素数据: 每行 1 个 filter 字节 + w*3 (RGB)
  $raw = New-Object 'System.Collections.Generic.List[byte]'
  for ($y = 0; $y -lt $h; $y++) {
    $raw.Add(0)
    for ($x = 0; $x -lt $w; $x++) {
      $raw.Add([byte](($x * 2) -band 0xFF))
      $raw.Add([byte](($y * 3) -band 0xFF))
      $raw.Add([byte](128))
    }
  }
  $rawBytes = $raw.ToArray()
  $deflated = Compress-Deflate $rawBytes
  # zlib 包装: 0x78 0x01 + deflate + adler32
  $idat = New-Object 'System.Collections.Generic.List[byte]'
  $idat.Add(0x78); $idat.Add(0x01)
  Append-Bytes $idat $deflated
  $adler = Get-Adler32 $rawBytes
  for ($i = 3; $i -ge 0; $i--) { $idat.Add([byte](($adler -shr (8 * $i)) -band 0xFF)) }
  $idatBytes = $idat.ToArray()

  $ihdr = New-Object byte[] 13
  Set-U32BE $ihdr 0 ([uint32]$w)
  Set-U32BE $ihdr 4 ([uint32]$h)
  $ihdr[8] = 8   # bit depth
  $ihdr[9] = 2   # color type RGB
  $ihdr[10] = 0; $ihdr[11] = 0; $ihdr[12] = 0

  $out = New-Object System.IO.MemoryStream
  $out.Write([byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), 0, 8)
  foreach ($chunk in @(@('IHDR', $ihdr), @('IDAT', $idatBytes))) {
    $type = [System.Text.Encoding]::ASCII.GetBytes([string]$chunk[0])
    $payload = [byte[]]$chunk[1]
    $lenB = New-Object byte[] 4
    Set-U32BE $lenB 0 ([long]$payload.Length)
    $out.Write($lenB, 0, 4)
    $out.Write($type, 0, 4)
    $out.Write($payload, 0, $payload.Length)
    $crcData = New-Object byte[] ($type.Length + $payload.Length)
    [Array]::Copy($type, 0, $crcData, 0, 4)
    [Array]::Copy($payload, 0, $crcData, 4, $payload.Length)
    $crcB = New-Object byte[] 4
    Set-U32BE $crcB 0 (Get-Crc32 $crcData)
    $out.Write($crcB, 0, 4)
  }
  return $out.ToArray()
}

# ---------------------------------------------------------------- JPEG (120x80)
function New-Jpeg([int]$w, [int]$h) {
  $ms = New-Object System.IO.MemoryStream
  $ms.Write([byte[]](0xFF, 0xD8), 0, 2)
  # APP0 (JFIF)
  $app0 = New-Object byte[] 16
  Set-U16BE $app0 0 16
  $jfif = [System.Text.Encoding]::ASCII.GetBytes('JFIF')
  [Array]::Copy($jfif, 0, $app0, 2, 4)
  $app0[6] = 0; $app0[7] = 1; $app0[8] = 1; $app0[9] = 0
  $app0[10] = 0; $app0[11] = 1; $app0[12] = 0; $app0[13] = 1
  $app0[14] = 0; $app0[15] = 0
  $ms.Write([byte[]](0xFF, 0xE0), 0, 2)
  $ms.Write($app0, 0, 16)
  # DQT
  $dqt = New-Object byte[] 67
  Set-U16BE $dqt 0 67
  $dqt[2] = 0
  $ms.Write([byte[]](0xFF, 0xDB), 0, 2)
  $ms.Write($dqt, 0, 67)
  # SOF0
  $sof = New-Object byte[] 17
  Set-U16BE $sof 0 17
  $sof[2] = 8
  Set-U16BE $sof 3 $h
  Set-U16BE $sof 5 $w
  $sof[7] = 3
  $sof[8] = 1; $sof[9] = 0x11; $sof[10] = 0
  $sof[11] = 2; $sof[12] = 0x11; $sof[13] = 0
  $sof[14] = 3; $sof[15] = 0x11; $sof[16] = 0
  $ms.Write([byte[]](0xFF, 0xC0), 0, 2)
  $ms.Write($sof, 0, 17)
  # SOS
  $sos = New-Object byte[] 12
  Set-U16BE $sos 0 12
  $sos[2] = 3
  $sos[3] = 1; $sos[4] = 0
  $sos[5] = 2; $sos[6] = 0
  $sos[7] = 3; $sos[8] = 0
  $sos[9] = 0; $sos[10] = 63; $sos[11] = 0
  $ms.Write([byte[]](0xFF, 0xDA), 0, 2)
  $ms.Write($sos, 0, 12)
  $ms.Write([byte[]](0xFF, 0xD9), 0, 2)
  return $ms.ToArray()
}

# ---------------------------------------------------------------- WebP VP8L (120x80)
function New-Webp([int]$w, [int]$h) {
  $payload = New-Object byte[] 5
  $payload[0] = 0x2F
  $val = ([long]($w - 1)) -bor (([long]($h - 1)) -shl 14)
  for ($i = 0; $i -lt 4; $i++) { $payload[1 + $i] = [byte](($val -shr (8 * $i)) -band 0xFF) }
  $chunk = New-Object byte[] 13
  $chunk[0] = 0x56; $chunk[1] = 0x50; $chunk[2] = 0x38; $chunk[3] = 0x4C   # VP8L
  Set-U32LE $chunk 4 5
  [Array]::Copy($payload, 0, $chunk, 8, 5)
  $out = New-Object byte[] (12 + 13)
  $out[0] = 0x52; $out[1] = 0x49; $out[2] = 0x46; $out[3] = 0x46             # RIFF
  Set-U32LE $out 4 13
  $out[8] = 0x57; $out[9] = 0x45; $out[10] = 0x42; $out[11] = 0x50           # WEBP
  [Array]::Copy($chunk, 0, $out, 12, 13)
  return $out
}

# ---------------------------------------------------------------- XLSX
function New-Xlsx([string]$path) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $fs = [System.IO.File]::Create($path)
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  function Add-Entry([string]$name, [string]$content) {
    $e = $zip.CreateEntry($name)
    $sw = New-Object System.IO.StreamWriter($e.Open(), $utf8)
    $sw.Write($content)
    $sw.Close()
  }
  Add-Entry '[Content_Types].xml' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>
'@
  Add-Entry '_rels/.rels' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@
  Add-Entry 'xl/workbook.xml' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="订单" sheetId="1" r:id="rId1"/></sheets>
</workbook>
'@
  Add-Entry 'xl/_rels/workbook.xml.rels' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
'@
  Add-Entry 'xl/sharedStrings.xml' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
<si><t>商品</t></si><si><t>价格</t></si><si><t>数量</t></si><si><t>手机壳</t></si><si><t>数据线</t></si><si><t>充电器</t></si>
</sst>
'@
  Add-Entry 'xl/worksheets/sheet1.xml' @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>29.9</v></c><c r="C2"><v>120</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>15.5</v></c><c r="C3"><v>300</v></c></row>
<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><v>45</v></c><c r="C4"><v>80</v></c></row>
</sheetData>
</worksheet>
'@
  $zip.Dispose()
  $fs.Close()
}

# ---------------------------------------------------------------- PDF (1 页)
function New-Pdf([string]$path) {
  $textEnc = New-Object System.Text.UTF8Encoding($false)
  $content = "BT /F1 12 Tf 72 720 Td (Hello, Ecommerce PDF) Tj ET`nBT /F1 12 Tf 72 700 Td (Order #1001) Tj ET`n"
  $contentBytes = $textEnc.GetBytes($content)
  $compressed = Compress-Deflate $contentBytes
  $length = $compressed.Length

  $script:all = New-Object 'System.Collections.Generic.List[byte]'
  $script:off = 0
  function Add-Txt([string]$s) {
    $b = $textEnc.GetBytes($s)
    foreach ($x in $b) { $script:all.Add($x) }
    $script:off += $b.Length
  }
  function Add-Bin([byte[]]$b) {
    foreach ($x in $b) { $script:all.Add($x) }
    $script:off += $b.Length
  }

  $offsets = @()
  Add-Txt "%PDF-1.4`n"
  $offsets += $script:off
  Add-Txt "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n"
  $offsets += $script:off
  Add-Txt "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n"
  $offsets += $script:off
  Add-Txt "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`nendobj`n"
  $offsets += $script:off
  Add-Txt "4 0 obj`n<< /Length $length /Filter /FlateDecode >>`nstream`n"
  Add-Bin $compressed
  Add-Txt "`nendstream`nendobj`n"
  $offsets += $script:off
  Add-Txt "5 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n"

  $xrefOff = $script:off
  Add-Txt "xref`n0 6`n"
  Add-Txt "0000000000 65535 f `n"
  foreach ($o in $offsets) { Add-Txt ("{0:D10} 00000 n `n" -f $o) }
  Add-Txt "trailer`n<< /Size 6 /Root 1 0 R >>`nstartxref`n$xrefOff`n%%EOF`n"

  [System.IO.File]::WriteAllBytes($path, $all.ToArray())
}

# ---------------------------------------------------------------- XLS (OLE2 + BIFF8)
function New-Xls([string]$path) {
  # ---- BIFF8 工作簿 ----
  $sstStrings = @('商品', '价格', '数量', '手机壳', '数据线', '充电器')
  $sst = New-Object 'System.Collections.Generic.List[byte]'
  Append-U16 $sst $sstStrings.Count
  Append-U16 $sst $sstStrings.Count
  foreach ($s in $sstStrings) {
    $chars = $s.ToCharArray()
    Append-U16 $sst $chars.Length   # cch（字符数）
    Append-U8 $sst 1                # flags: fHighByte=1（UTF-16LE 字符）
    foreach ($ch in $chars) { Append-U16 $sst ([int][char]$ch) }
  }
  $sstBytes = $sst.ToArray()

  $g = New-Object 'System.Collections.Generic.List[byte]'
  # BOF (globals)
  $bof = New-Object 'System.Collections.Generic.List[byte]'
  Append-U16 $bof 0x0600; Append-U16 $bof 0x0005; Append-U16 $bof 0x0DBB; Append-U16 $bof 0x07CC
  Append-U32 $bof 0; Append-U32 $bof 0
  Append-U16 $g 0x0809; Append-U16 $g $bof.Count; Append-Bytes $g $bof.ToArray()

  # BOUNDSHEET（lbPlyPos 占位，稍后回填）
  $bs = New-Object 'System.Collections.Generic.List[byte]'
  Append-U32 $bs 0
  Append-U8 $bs 0       # hsState
  Append-U8 $bs 0       # dt (worksheet)
  $sheetName = 'Sheet1'
  $snBytes = [System.Text.Encoding]::ASCII.GetBytes($sheetName)
  Append-U8 $bs $snBytes.Length
  Append-U8 $bs 0       # flags: 无高字节
  Append-Bytes $bs $snBytes
  Append-U16 $g 0x0085; Append-U16 $g $bs.Count; Append-Bytes $g $bs.ToArray()

  # SST
  Append-U16 $g 0x00FC; Append-U16 $g $sstBytes.Length; Append-Bytes $g $sstBytes

  # EOF (globals)
  Append-U16 $g 0x000A; Append-U16 $g 0

  # 回填 BOUNDSHEET 的 lbPlyPos = 所有全局记录之后（BOF 20 字节 + BOUNDSHEET 记录头 4 字节）
  $lbPlyPos = $g.Count
  for ($i = 0; $i -lt 4; $i++) { $g[24 + $i] = [byte](($lbPlyPos -shr (8 * $i)) -band 0xFF) }

  # ---- 工作表子流 ----
  function Add-Record([System.Collections.Generic.List[byte]]$l, [int]$id, [byte[]]$data) {
    Append-U16 $l $id
    Append-U16 $l $data.Length
    Append-Bytes $l $data
  }
  function New-RowRec([int]$rw) {
    $r = New-Object 'System.Collections.Generic.List[byte]'
    Append-U16 $r $rw; Append-U16 $r 0; Append-U16 $r 2; Append-U16 $r 0xFF; Append-U16 $r 0
    Append-U16 $r 0; Append-U16 $r 0; Append-U16 $r 0
    return $r.ToArray()
  }
  function New-LabelSst([int]$rw, [int]$col, [int]$sstIdx) {
    $r = New-Object 'System.Collections.Generic.List[byte]'
    Append-U16 $r $rw; Append-U16 $r $col; Append-U16 $r 0; Append-U32 $r $sstIdx
    return $r.ToArray()
  }
  function New-Number([int]$rw, [int]$col, [double]$v) {
    $r = New-Object 'System.Collections.Generic.List[byte]'
    Append-U16 $r $rw; Append-U16 $r $col; Append-U16 $r 0; Append-Ieee64 $r $v
    return $r.ToArray()
  }
  function New-Rk([int]$rw, [int]$col, [int]$intVal) {
    $r = New-Object 'System.Collections.Generic.List[byte]'
    Append-U16 $r $rw; Append-U16 $r $col; Append-U16 $r 0
    Append-U32 $r (([long]$intVal -shl 2) -bor 1)
    return $r.ToArray()
  }

  $s = New-Object 'System.Collections.Generic.List[byte]'
  # BOF (worksheet)
  $bof2 = New-Object 'System.Collections.Generic.List[byte]'
  Append-U16 $bof2 0x0600; Append-U16 $bof2 0x0010; Append-U16 $bof2 0x0DBB; Append-U16 $bof2 0x07CC
  Append-U32 $bof2 0; Append-U32 $bof2 0
  Add-Record $s 0x0809 $bof2.ToArray()

  Add-Record $s 0x0208 (New-RowRec 0)
  Add-Record $s 0x0208 (New-RowRec 1)
  Add-Record $s 0x0208 (New-RowRec 2)
  Add-Record $s 0x0208 (New-RowRec 3)

  Add-Record $s 0x00FD (New-LabelSst 0 0 0)
  Add-Record $s 0x00FD (New-LabelSst 0 1 1)
  Add-Record $s 0x00FD (New-LabelSst 0 2 2)
  Add-Record $s 0x00FD (New-LabelSst 1 0 3)
  Add-Record $s 0x0203 (New-Number 1 1 29.9)
  Add-Record $s 0x0203 (New-Number 1 2 120)
  Add-Record $s 0x00FD (New-LabelSst 2 0 4)
  Add-Record $s 0x0203 (New-Number 2 1 15.5)
  Add-Record $s 0x0203 (New-Number 2 2 300)
  Add-Record $s 0x00FD (New-LabelSst 3 0 5)
  Add-Record $s 0x027E (New-Rk 3 1 45)
  Add-Record $s 0x0203 (New-Number 3 2 80)
  Add-Record $s 0x000A (New-Object byte[] 0)

  $wbList = New-Object 'System.Collections.Generic.List[byte]'
  Append-Bytes $wbList $g.ToArray()
  Append-Bytes $wbList $s.ToArray()
  $wb = $wbList.ToArray()

  # ---- OLE2 复合文档包装 ----
  $sectorSize = 512
  $miniSize = 64
  $cutoff = 4096
  $miniCutoff = 4096
  $nMini = [math]::Ceiling($wb.Length / $miniSize)
  $miniTotal = [int]$nMini * $miniSize
  $nMs = [math]::Ceiling($miniTotal / $sectorSize)          # mini 流占用普通扇区数 (OLE 扇区 0..nMs-1)
  $miniFatSector = $nMs                                     # 紧随 mini 流
  $dirSector = $miniFatSector + 1
  $fatSector = $dirSector + 1
  $totalSectors = $fatSector + 1

  $END = 0xFFFFFFFE; $FREE = 0xFFFFFFFF; $FATSECT = 0xFFFFFFFD

  $header = New-Object byte[] 512
  $sig = [byte[]](0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)
  [Array]::Copy($sig, 0, $header, 0, 8)
  Set-U16LE $header 24 0x003E   # minor
  Set-U16LE $header 26 0x0003   # major
  Set-U16LE $header 28 0xFFFE   # byte order
  Set-U16LE $header 30 9        # sector shift
  Set-U16LE $header 32 6        # mini sector shift
  Set-U32LE $header 44 1        # num FAT sectors
  Set-U32LE $header 48 $dirSector
  Set-U32LE $header 56 $miniCutoff
  Set-U32LE $header 60 $miniFatSector
  Set-U32LE $header 64 1        # num mini FAT sectors
  Set-U32LE $header 68 $END     # no DIFAT sectors
  Set-U32LE $header 72 0
  for ($i = 0; $i -lt 109; $i++) { Set-U32LE $header (76 + $i * 4) $FREE }
  Set-U32LE $header 76 $fatSector

  $file = New-Object System.IO.MemoryStream
  $file.Write($header, 0, 512)
  # mini 流扇区
  $miniStreamBytes = New-Object byte[] ($nMs * $sectorSize)
  [Array]::Copy($wb, 0, $miniStreamBytes, 0, $wb.Length)
  for ($i = 0; $i -lt $nMs; $i++) { $file.Write($miniStreamBytes, $i * $sectorSize, $sectorSize) }
  # miniFAT 扇区
  $mf = New-Object 'System.Collections.Generic.List[byte]'
  for ($i = 0; $i -lt $nMini; $i++) {
    if ($i -lt ($nMini - 1)) { Append-U32 $mf ([long]$i + 1) } else { Append-U32 $mf $END }
  }
  while ($mf.Count -lt ($sectorSize / 4) * 4) { Append-U32 $mf $FREE }
  $mfBytes = $mf.ToArray()
  $file.Write($mfBytes, 0, $sectorSize)
  # 目录扇区
  $dirBytes = New-Object byte[] $sectorSize
  function Write-DirEntry([byte[]]$buf, [int]$idx, [string]$name, [int]$type, [long]$start, [long]$size, [int]$child, [int]$left, [int]$right) {
    $o = $idx * 128
    if ($name -ne '') {
      $nb = [System.Text.Encoding]::Unicode.GetBytes($name + "`0")
      [Array]::Copy($nb, 0, $buf, $o, $nb.Length)
      Set-U16LE $buf ($o + 64) $nb.Length
    }
    $buf[$o + 66] = [byte]$type
    Set-U32LE $buf ($o + 68) $left
    Set-U32LE $buf ($o + 72) $right
    Set-U32LE $buf ($o + 76) $child
    Set-U32LE $buf ($o + 116) $start
    Set-U32LE $buf ($o + 120) $size
    Set-U32LE $buf ($o + 124) 0
  }
  Write-DirEntry $dirBytes 0 'Root Entry' 5 0 $miniTotal 1 $FREE $FREE
  Write-DirEntry $dirBytes 1 'Workbook' 2 0 $wb.Length $FREE $FREE $FREE
  $file.Write($dirBytes, 0, $sectorSize)
  # FAT 扇区（OLE 扇区编号：0 = header 之后的第一个扇区）
  $fat = New-Object 'System.Collections.Generic.List[byte]'
  for ($s = 0; $s -lt $totalSectors; $s++) {
    if ($s -lt $nMs) {
      if ($s -lt ($nMs - 1)) { Append-U32 $fat ([long]$s + 1) } else { Append-U32 $fat $END }
    }
    elseif ($s -eq $miniFatSector) { Append-U32 $fat $END }
    elseif ($s -eq $dirSector) { Append-U32 $fat $END }
    elseif ($s -eq $fatSector) { Append-U32 $fat $FATSECT }
    else { Append-U32 $fat $FREE }
  }
  while ($fat.Count -lt ($sectorSize / 4) * 4) { Append-U32 $fat $FREE }
  $fatBytes = $fat.ToArray()
  $file.Write($fatBytes, 0, $sectorSize)

  [System.IO.File]::WriteAllBytes($path, $file.ToArray())
}

# ---------------------------------------------------------------- 文本样本
$utf8 = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText((Join-Path $script:Dir 'sample.txt'), "电商订单说明`n================`n这是用于测试 read_file 工具的文本文件。`n订单号: ORD-2025-0001`n状态: 已发货`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $script:Dir 'sample.md'), "# 商品上架规范`n`n- 标题不超过 60 字`n- 主图 800x800`n- 价格单位: 元`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $script:Dir 'sample.csv'), "商品,价格,数量`n手机壳,29.9,120`n数据线,15.5,300`n充电器,45,80`n", $utf8)
# GBK 编码 CSV
$gbk = [System.Text.Encoding]::GetEncoding(936)
[System.IO.File]::WriteAllBytes((Join-Path $script:Dir 'sample-gbk.csv'), $gbk.GetBytes("商品,价格,数量`r`n手机壳,29.9,120`r`n数据线,15.5,300`r`n充电器,45,80`r`n"))
# 二进制样本
[System.IO.File]::WriteAllBytes((Join-Path $script:Dir 'sample.png'), (New-Png 120 80))
[System.IO.File]::WriteAllBytes((Join-Path $script:Dir 'sample.jpg'), (New-Jpeg 120 80))
[System.IO.File]::WriteAllBytes((Join-Path $script:Dir 'sample.webp'), (New-Webp 120 80))
New-Xlsx (Join-Path $script:Dir 'sample.xlsx')
New-Pdf (Join-Path $script:Dir 'sample.pdf')
New-Xls (Join-Path $script:Dir 'sample.xls')

Write-Host 'Fixtures generated:'
Get-ChildItem $script:Dir | Select-Object Name, Length | Format-Table -AutoSize | Out-String

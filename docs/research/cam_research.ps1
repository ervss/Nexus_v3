$ErrorActionPreference='SilentlyContinue'
$root='https://filester.me/f/442dd49c4567186e'
$html=(Invoke-WebRequest -UseBasicParsing $root).Content
$rx='<a href="(/f/[^"]+)" class="subfolder-item"[\s\S]*?<div class="subfolder-name"[^>]*>(.*?)</div>[\s\S]*?<div class="subfolder-meta"[^>]*>(.*?)</div>'
$items=[regex]::Matches($html,$rx) | ForEach-Object { [pscustomobject]@{Name=$_.Groups[2].Value.Trim(); Url=('https://filester.me'+$_.Groups[1].Value); Files=$_.Groups[3].Value.Trim()} }
$out=foreach($item in $items){
  $q=[uri]::EscapeDataString('"'+$item.Name+'" cam model male show OR male content')
  $url="https://www.google.com/search?q=$q"
  $body=(Invoke-WebRequest -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0'} $url).Content
  $plain=[regex]::Replace($body,'<script[\s\S]*?</script>|<style[\s\S]*?</style>',' ')
  $plain=[regex]::Replace($plain,'<[^>]+>',' ')
  $plain=[System.Net.WebUtility]::HtmlDecode($plain)
  $hit=($plain -match '(?i)male\s*(show|content|performer|model)|boy.?girl|straight|couple')
  [pscustomobject]@{Name=$item.Name;Folder=$item.Url;Files=$item.Files;SearchHit=$hit;Evidence=($plain -replace '\s+',' ').Substring(0,[Math]::Min(500,($plain -replace '\s+',' ').Length))}
}
$out | Export-Csv -NoTypeInformation -Encoding UTF8 'tools/cam_research_results.csv'
Write-Output "Processed $($out.Count) names"

# 公开合法数据源目录

> 只收录公开、合法、可引用的来源。付费数据库可以作为线索，但写入数据时请引用其背后的公开原始文件。

## 通用

| 来源 | 内容 | 用法 |
|---|---|---|
| [Wikidata](https://www.wikidata.org/) / [SPARQL](https://query.wikidata.org/) | 结构化的人物、职务、亲属（P22/P25/P26/P40/P3373/P1038）、教育、雇主、持股 | `ingest wikidata` 连接器；`ctos wd` 查 QID |
| 维基百科（中/英） | 履历、家族、争议 | 首选引用 |
| [ICIJ Offshore Leaks](https://offshoreleaks.icij.org/) | 离岸公司（Offshore Leaks 2013、巴拿马文件 2016、天堂文件 2017、潘多拉文件 2021） | 已入原始仓库；审核确认后经 `icij` 层进入图谱 |
| [OpenSanctions](https://www.opensanctions.org/) | 政治公众人物（PEP）、制裁名单、亲属与关联人 | 已入原始仓库，`opensanctions` 层（CC BY-NC 4.0，非商业） |
| [LittleSis](https://littlesis.org/) | 美国权力关系数据库（“谁认识谁”） | 仓库入库已就绪（需手动下载批量文件，见 [warehouse.md](warehouse.md)） |

## 中国

| 来源 | 内容 |
|---|---|
| 新华社、人民网《中国政要资料库》、中国政府网 | 官方任免、履历、会议公报 |
| [中央纪委国家监委网站](https://www.ccdi.gov.cn/) | 审查调查、党纪政务处分通报（落马时间线的权威来源） |
| 国防部例行记者会 | 军队高层免职与处分 |
| 国家企业信用信息公示系统 | 公司股东、法定代表人、高管（工商登记） |
| [巨潮资讯网](http://www.cninfo.com.cn/)（A 股）、[港交所披露易](https://www.hkexnews.hk/) | 上市公司年报、股东名单、董监高持股（“券商/交易所披露”） |
| 裁判文书网、各级法院公告 | 判决书（受贿、利益输送的认定事实） |
| 财新、经济观察报、21 世纪经济报道、SCMP、联合早报 | 调查报道与人事动态 |
| 彭博（2012 习家财富）、纽时（2012 温家财富，普利策奖）、ICIJ（2014 中国离岸解密） | 里程碑式调查报道 |
| Brookings 李成（Cheng Li）等学术研究 | 派系、秘书、门生关系分析 |
| [zhao 项目](https://github.com/programthink/zhao) | 太子党家族数据（2016–2018，需核实更新） |

## 美国

| 来源 | 内容 |
|---|---|
| [SEC EDGAR](https://www.sec.gov/edgar) | Form 4（内部人交易）、13F（机构持仓）、DEF 14A（董事会、关联交易）、S-1 |
| 国会财产申报：[House Clerk](https://disclosures-clerk.house.gov/)、[Senate eFD](https://efdsearch.senate.gov/) | 议员及配偶持股与交易（STOCK Act） |
| [OGE 278](https://www.oge.gov/) | 行政官员财产申报与利益冲突协议 |
| [FEC](https://www.fec.gov/data/) / [OpenSecrets](https://www.opensecrets.org/) | 政治献金、超级 PAC、游说（FEC 2000–2026 全量已入仓库，`fec` 层） |
| [congress-legislators](https://github.com/unitedstates/congress-legislators)、[FJC](https://www.fjc.gov/history/judges) | 国会议员任期与跨库 ID、联邦法官任命（`us-officials` 层） |
| [Senate LDA](https://lda.senate.gov/) / [FARA](https://efile.fara.gov/) | 游说登记、外国代理人登记（中美关联的重要来源） |
| [Congress.gov](https://www.congress.gov/)、[Bioguide](https://bioguide.congress.gov/) | 议员履历、任期 |
| 白宫、各部会官网，Federal Register | 任命与人事 |
| PACER / CourtListener | 联邦法院文书 |
| Forbes / Bloomberg Billionaires | 财富排名（引用其公开页面） |
| 路透、美联、纽时、华邮、华日、Politico、Axios | 人事动态与调查报道 |

# -*- coding: utf-8 -*-
import json, collections

SAFETY_KEYS = ["全速域ACC","車道置中/維持","前方主動煞停","盲點偵測","後方橫向車流警示",
               "倒車主動煞停","駕駛疲勞警示","360度環景","前停車雷達","後停車雷達","EPB+AutoHold"]
COMFORT_KEYS = ["LED頭燈","電動尾門","雙區恆溫","後座出風口","皮質座椅","無線CarPlay","數位儀表",
                "中控螢幕9吋以上","無線充電","電動座椅","天窗","車頂行李架","抬頭顯示器"]

BRAND_COLOR = {
 "Toyota":"#C93A33","Honda":"#A82C26","Nissan":"#1A5596","Mazda":"#B36D0E","Kia":"#009475",
 "Hyundai":"#2878B0","Mitsubishi":"#703798","MG":"#972B39","Volkswagen":"#175F97","Suzuki":"#27794C"}

# id, brand, model, trim, series(folder), price, hp, torque, kml, tax, len, wid, hei, wb, cargo, warranty, dealer, safety11, comfort13
R = [
("yc-1","Toyota","Yaris Cross","享樂版","yaris-cross",695000,106,14.1,17.5,11920,4310,1770,1655,2620,458,"3年10萬公里","多","11100000001","1000100100000"),
("yc-2","Toyota","Yaris Cross","酷動版","yaris-cross",735000,106,14.1,17.5,11920,4310,1770,1655,2620,458,"3年10萬公里","多","11100000011","1001100100000"),
("yc-3","Toyota","Yaris Cross","潮玩版","yaris-cross",795000,106,14.1,17.5,11920,4310,1770,1655,2620,458,"3年10萬公里","多","11111000011","1111101100010"),
("cc-1","Toyota","Corolla Cross","1.8 汽油豪華","corolla-cross",809000,140,17.5,14.3,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11100000011","1001110100000"),
("cc-2","Toyota","Corolla Cross","1.8 Hybrid豪華","corolla-cross",849000,122,None,23.1,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11100000011","1001111100000"),
("cc-3","Toyota","Corolla Cross","1.8 汽油 The 60th","corolla-cross",889000,140,17.5,14.3,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11111001011","1001111100000"),
("cc-4","Toyota","Corolla Cross","1.8 汽油 GR Sport","corolla-cross",915000,140,17.5,14.3,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11100001011","1001110100000"),
("cc-5","Toyota","Corolla Cross","1.8 Hybrid The 60th","corolla-cross",919000,122,None,23.1,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11111001011","1001111100000"),
("cc-6","Toyota","Corolla Cross","1.8 Hybrid GR Sport","corolla-cross",985000,122,None,23.1,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11100001011","1101110101000"),
("cc-7","Toyota","Corolla Cross","1.8 Hybrid旗艦","corolla-cross",989000,122,None,23.1,11920,4460,1825,1620,2640,487,"3年10萬公里","多","11101000011","1101111101000"),
("hv-1","Honda","HR-V","S 汽油","hrv",799000,121,14.8,16.3,11920,4330,1790,1590,2610,None,"3年10萬公里","多","11100000011","1001110000000"),
("hv-2","Honda","HR-V","e:HEV S","hrv",899000,131,25.8,23.5,11920,4330,1790,1590,2610,None,"3年10萬公里","多","11100000011","1101111000000"),
("hv-3","Honda","HR-V","e:HEV Prestige","hrv",959000,131,25.8,23.5,11920,4330,1790,1590,2610,None,"3年10萬公里","多","11110000011","1111111011000"),
("hv-4","Honda","HR-V","e:HEV Prestige Super Edition","hrv",985000,131,25.8,23.5,11920,4330,1790,1590,2610,None,"3年10萬公里","多","11110001011","1111111011000"),
("ks-1","Nissan","Kicks","初綻版","kicks",749000,135,16.7,16.0,11920,4328,1760,1588,2620,None,"3年10萬公里","多","10100000001","1001001000000"),
("ks-2","Nissan","Kicks","初綻 Air","kicks",759000,135,16.7,16.0,11920,4328,1760,1588,2620,None,"3年10萬公里","多","10100000001","1011001000000"),
("ks-3","Nissan","Kicks","盛綻 Air","kicks",819000,135,16.7,16.0,11920,4328,1760,1588,2620,None,"3年10萬公里","多","10100001011","1011101000000"),
("ks-4","Nissan","Kicks","極綻版","kicks",855000,135,16.7,16.0,11920,4328,1760,1625,2620,None,"3年10萬公里","多","10111001011","1011101000010"),
("cx-1","Mazda","CX-30","20S Ace Edition","cx30",898000,165,21.7,15.0,17440,4395,1795,1540,2655,None,"3年10萬公里","中","11111111111","1111101100001"),
("cx-2","Mazda","CX-30","20S Premium","cx30",998000,165,21.7,15.0,17440,4395,1795,1540,2655,None,"3年10萬公里","中","11111111111","1111111100001"),
("cx-3","Mazda","CX-30","20S Homura","cx30",1098000,165,21.7,15.0,17440,4395,1795,1540,2655,None,"3年10萬公里","中","11111111111","1111111111001"),
("cx-4","Mazda","CX-30","20S Signature","cx30",1118000,165,21.7,15.0,17440,4395,1795,1540,2655,None,"3年10萬公里","中","11111111111","1111111111001"),
("st-1","Kia","Stonic","Signature","stonic",899000,115,20.4,19.8,8640,4165,1760,1500,2580,352,"5年不限里程","少","11111100111","1000111100010"),
("vn-1","Hyundai","Venue","GLA","venue",739000,123,15.7,17.1,11920,4040,1795,1615,2520,None,"5年15萬公里","中","11100010010","0000100000010"),
("vn-2","Hyundai","Venue","GLB 單色","venue",769000,123,15.7,17.1,11920,4040,1795,1615,2520,None,"5年15萬公里","中","11100010010","1000100010010"),
("vn-3","Hyundai","Venue","GLB 雙色","venue",779000,123,15.7,17.1,11920,4040,1795,1615,2520,None,"5年15萬公里","中","11100010010","1000100010010"),
("vn-4","Hyundai","Venue","GLC","venue",819000,123,15.7,17.1,11920,4040,1795,1615,2520,None,"5年15萬公里","中","11100010010","1000100010010"),
("mf-1","Hyundai","Mufasa","GLA","mufasa",859000,160,19.7,14.8,17440,4465,1870,1695,2680,None,"5年15萬公里","中","11110011111","1001111100000"),
("mf-2","Hyundai","Mufasa","GLB","mufasa",899000,160,19.7,14.8,17440,4465,1870,1695,2680,None,"5年15萬公里","中","11111011111","1011111100010"),
("mf-3","Hyundai","Mufasa","GLC","mufasa",949000,160,19.7,14.8,17440,4465,1870,1695,2680,None,"5年15萬公里","中","11111011111","1111111111110"),
("xf-1","Mitsubishi","XForce","樂享版","xforce",799000,105,14.4,17.0,11920,4390,1810,1660,2650,429,"3年10萬公里","中","11100000001","1010111100000"),
("xf-2","Mitsubishi","XForce","酷享版","xforce",829000,105,14.4,17.0,11920,4390,1810,1660,2650,429,"3年10萬公里","中","11111000011","1110111110000"),
("xf-3","Mitsubishi","XForce","狂享版","xforce",842000,105,14.4,17.0,11920,4390,1810,1660,2650,429,"3年10萬公里","中","11111000011","1110111110000"),
("zs-1","MG","ZS","玩家版","mgzs",699000,120,15.3,15.3,11920,4323,1809,1653,2585,448,"5年15萬公里","少","11111001011","1001101100010"),
("zs-2","MG","ZS","玩美版","mgzs",729000,120,15.3,15.3,11920,4323,1809,1653,2585,448,"5年15萬公里","少","11111001011","1101101101010"),
("tc-1","Volkswagen","T-Cross","230 TSI Life","tcross",898000,115,20.4,17.7,8640,4135,1784,1573,2551,None,"3年不限里程","少","11100110111","1000011100010"),
("tc-2","Volkswagen","T-Cross","230 TSI Tech","tcross",998000,115,20.4,17.7,8640,4135,1784,1573,2551,None,"3年不限里程","少","11100110111","1010111111010"),
("tc-3","Volkswagen","T-Cross","230 TSI Style Design","tcross",1068000,115,20.4,17.7,8640,4135,1784,1573,2551,None,"3年不限里程","少","11111110111","1010111111010"),
("sx-1","Suzuki","SX4 S-Cross","2WD","sx4",980000,110.02,23.97,19.4,11920,4305,1785,1585,2600,440,"3年10萬公里","少","11111011111","1010101100010"),
]

cars = []
for (cid,brand,model,trim,series,price,hp,tq,kml,tax,L,W,H,WB,cargo,warr,dealer,s11,c13) in R:
    assert len(s11)==11 and len(c13)==13, cid
    safety = collections.OrderedDict((k, s11[i]=="1") for i,k in enumerate(SAFETY_KEYS))
    comfort = collections.OrderedDict((k, c13[i]=="1") for i,k in enumerate(COMFORT_KEYS))
    cars.append(collections.OrderedDict([
        ("id",cid),("brand",brand),("model",model),("trim",trim),("series",series),
        ("brandColor",BRAND_COLOR[brand]),
        ("price",price),("hp",hp),("torque",tq),("kml",kml),("tax",tax),
        ("length",L),("width",W),("height",H),("wheelbase",WB),
        ("cargo",cargo),("cargoNote","原廠從未公布" if cargo is None else None),
        ("warranty",warr),("dealer",dealer),
        ("safetyCount",s11.count("1")),("comfortCount",c13.count("1")),
        ("safetyCode",s11),("comfortCode",c13),
        ("safety",safety),("comfort",comfort),
    ]))

out = collections.OrderedDict([
    ("meta", collections.OrderedDict([
        ("count", len(cars)),
        ("currency","TWD"),
        ("safetyOrder", SAFETY_KEYS),
        ("comfortOrder", COMFORT_KEYS),
        ("brandColors", BRAND_COLOR),
        ("cargoNullNote","行李廂容積為 null 者，代表原廠自始未曾揭露該數值，不是 0。計算一律給中位數 0.5；畫面一律顯示各車的 cargoNote 字串。"),
    ])),
    ("cars", cars),
])
with open("/home/user/carmuseum/data/cars.json","w",encoding="utf-8") as f:
    json.dump(out,f,ensure_ascii=False,indent=2)
    f.write("\n")

# ---- self checks ----
n_null = sum(1 for c in cars if c["cargo"] is None)
print("cars:",len(cars),"cargo null:",n_null)
def cnt(fn): return sum(1 for c in cars if fn(c))
print("缺倒車主動煞停(應31):", cnt(lambda c: not c["safety"]["倒車主動煞停"]))
print("缺盲點偵測(應19):", cnt(lambda c: not c["safety"]["盲點偵測"]))
print("缺後方橫向車流(應21):", cnt(lambda c: not c["safety"]["後方橫向車流警示"]))
print("缺360環景(應22):", cnt(lambda c: not c["safety"]["360度環景"]))
print("缺疲勞警示(應24):", cnt(lambda c: not c["safety"]["駕駛疲勞警示"]))
print("缺前停車雷達(應27):", cnt(lambda c: not c["safety"]["前停車雷達"]))
print("年稅17440(應7):", cnt(lambda c: c["tax"]==17440))
print("保固3年(應29):", cnt(lambda c: c["warranty"].startswith("3年")))
print("軸距<2600(應10):", cnt(lambda c: c["wheelbase"]<2600))
print("車長>4390(應14):", cnt(lambda c: c["length"]>4390))
print("油耗<16(應12):", cnt(lambda c: c["kml"]<16))
print("馬力<120(應11):", cnt(lambda c: c["hp"]<120))
print("cargo null(應22):", n_null)
print("缺後座出風口(應13):", cnt(lambda c: not c["comfort"]["後座出風口"]))
print("缺電動尾門(應25):", cnt(lambda c: not c["comfort"]["電動尾門"]))
print("缺雙區恆溫(應21):", cnt(lambda c: not c["comfort"]["雙區恆溫"]))
print("缺無線充電(應27):", cnt(lambda c: not c["comfort"]["無線充電"]))
print("缺無線CarPlay(應15):", cnt(lambda c: not c["comfort"]["無線CarPlay"]))
print("據點少(應7):", cnt(lambda c: c["dealer"]=="少"))
print("CX30+Mufasa(應7):", cnt(lambda c: c["model"] in ("CX-30","Mufasa")))
print("車高<1560(應7):", cnt(lambda c: c["height"]<1560))
print("安全<6項(應12):", cnt(lambda c: c["safetyCount"]<6))
print("油耗<17(應19):", cnt(lambda c: c["kml"]<17))
print("馬力<120或據點少(應18):", cnt(lambda c: c["hp"]<120 or c["dealer"]=="少"))

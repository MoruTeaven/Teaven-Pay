# Teaven Pay API 接口文档

## 概述

Teaven Pay 提供完全兼容易支付标准的 API 接口，支持支付宝、微信支付、QQ钱包等多种支付方式。

### 基础信息

| 项目 | 说明 |
|------|------|
| Base URL | `https://your-domain.com` |
| 请求方式 | GET / POST |
| 响应格式 | JSON |
| 字符编码 | UTF-8 |

### 错误码

| 错误码 | 说明 |
|--------|------|
| 1 | 成功 |
| 0 | 失败 |
| -1 | 参数错误 |
| -2 | 签名验证失败 |
| -3 | 商户不存在或密钥错误 |
| -4 | 订单不存在 |
| -5 | 系统错误 |

---

## 签名算法

### MD5 签名

1. 将所有请求参数按参数名 ASCII 码从小到大排序
2. 将排序后的参数按照 `key=value` 的格式拼接
3. 在拼接串首尾加上商户密钥 `api_key`
4. 对拼接串进行 MD5 加密，转为小写

```javascript
function generateSign(params, apiKey) {
    // 1. 排序
    const sortedKeys = Object.keys(params).sort();
    
    // 2. 拼接
    let signStr = '';
    for (const key of sortedKeys) {
        if (params[key] !== '' && params[key] !== undefined && key !== 'sign' && key !== 'sign_type') {
            signStr += key + '=' + params[key] + '&';
        }
    }
    signStr = signStr.slice(0, -1); // 移除最后一个 &
    
    // 3. 首尾加密钥
    signStr = apiKey + signStr + apiKey;
    
    // 4. MD5 加密
    return md5(signStr).toLowerCase();
}
```

### RSA 签名

1. 将所有请求参数按参数名 ASCII 码从小到大排序
2. 将排序后的参数按照 `key=value` 的格式拼接，用 `&` 连接
3. 使用商户私钥对拼接串进行 RSA-SHA256 签名
4. 将签名结果进行 Base64 编码

```javascript
function generateRSASign(params, privateKey) {
    // 1. 排序
    const sortedKeys = Object.keys(params).sort();
    
    // 2. 拼接
    let signParts = [];
    for (const key of sortedKeys) {
        if (params[key] !== '' && params[key] !== undefined && key !== 'sign' && key !== 'sign_type') {
            signParts.push(key + '=' + params[key]);
        }
    }
    const signStr = signParts.join('&');
    
    // 3. RSA 签名
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signStr);
    return sign.sign(privateKey, 'base64');
}
```

---

## 接口列表

### 1. 统一支付接口

#### 1.1 发起支付 (同步跳转)

**POST** `/submit.php`

适用于网页跳转支付场景，返回 HTML 页面或跳转链接。

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| type | string | 是 | 支付方式: alipay/wxpay/qqpay |
| out_trade_no | string | 是 | 商户订单号，只能包含字母、数字、点、下划线、横线、竖线 |
| notify_url | string | 是 | 异步通知地址，必须是有效 URL |
| return_url | string | 是 | 同步跳转地址，必须是有效 URL |
| name | string | 是 | 商品名称，最长 127 字符 |
| money | decimal | 是 | 金额，必须大于 0，最多 2 位小数 |
| sign | string | 是 | 签名 |
| sign_type | string | 否 | 签名类型: MD5/RSA，默认 MD5 |
| param | string | 否 | 自定义参数，会原样返回 |
| sitename | string | 否 | 站点名称 |

**响应:**

成功时返回 HTML 页面（收银台或直接跳转第三方支付）。
失败时返回错误信息页面。

---

#### 1.2 发起支付 (API 模式)

**POST** `/api.php?act=submit`

适用于 APP、小程序等需要获取支付参数的场景，返回 JSON。

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| type | string | 是 | 支付方式 |
| out_trade_no | string | 是 | 商户订单号 |
| notify_url | string | 是 | 异步通知地址 |
| name | string | 是 | 商品名称 |
| money | decimal | 是 | 金额 |
| clientip | string | 是 | 客户端 IP 地址 |
| sign | string | 是 | 签名 |
| sign_type | string | 否 | 签名类型 |
| device | string | 否 | 设备类型: pc/mobile/qq/wechat/alipay/app |
| method | string | 否 | 支付方式: web/jump/jsapi/scan |
| sub_openid | string | 否 | 子商户 openid (jsapi 必填) |
| sub_appid | string | 否 | 子商户 appid |
| auth_code | string | 否 | 付款码 (scan 必填) |
| param | string | 否 | 自定义参数 |
| channel_id | string | 否 | 指定支付通道 |
| cert_no | string | 否 | 身份证号码 |
| cert_name | string | 否 | 身份证姓名 |
| min_age | int | 否 | 最低年龄限制 |

**响应:**

```json
// 成功 - 网页支付
{
    "code": 1,
    "msg": "创建订单成功",
    "trade_no": "202606221234567890",
    "payurl": "https://your-domain.com/pay/202606221234567890"
}

// 成功 - 二维码支付
{
    "code": 1,
    "msg": "创建订单成功",
    "trade_no": "202606221234567890",
    "qrcode": "weixin://wxpay/bizpayurl?pr=xxxxx",
    "payurl": "https://your-domain.com/pay/202606221234567890"
}

// 成功 - JSAPI 支付
{
    "code": 1,
    "msg": "创建订单成功",
    "trade_no": "202606221234567890",
    "jsapi": {
        "appId": "wx1234567890",
        "timeStamp": "1624320000",
        "nonceStr": "5K8264ILTKCH16CQ2502SI8ZNMTM67VS",
        "package": "prepay_id=wx202606221234567890",
        "signType": "RSA",
        "paySign": "xxx"
    }
}

// 失败
{
    "code": -1,
    "msg": "参数错误"
}
```

---

### 2. 订单查询接口

#### 2.1 查询单个订单

**GET** `/api.php?act=order`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| trade_no | string | 否 | 平台订单号 (与 out_trade_no 二选一) |
| out_trade_no | string | 否 | 商户订单号 |
| sign | string | 是 | 签名 |
| sign_type | string | 否 | 签名类型 |

**响应:**

```json
{
    "code": 1,
    "msg": "succ",
    "trade_no": "202606221234567890",
    "out_trade_no": "ORDER_123456",
    "api_trade_no": "",           // 第三方交易号
    "type": "alipay",             // 支付方式
    "pid": "1001",                // 商户ID
    "name": "商品名称",
    "money": "10.00",             // 订单金额
    "param": "",                  // 自定义参数
    "buyer": "买家账号",
    "status": 1,                  // 0未支付 1已支付 2已退款 3已关闭
    "addtime": "2026-06-22 12:00:00",
    "endtime": "2026-06-22 12:05:00"
}
```

---

#### 2.2 批量查询订单

**GET** `/api.php?act=orders`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| limit | int | 否 | 每页数量，默认 10，最大 50 |
| offset | int | 否 | 偏移量，默认 0 |
| status | int | 否 | 订单状态筛选 |

**响应:**

```json
{
    "code": 1,
    "msg": "查询订单记录成功！",
    "count": 2,
    "data": [
        {
            "trade_no": "202606221234567890",
            "out_trade_no": "ORDER_123456",
            "type": "alipay",
            "pid": "1001",
            "name": "商品名称",
            "money": "10.00",
            "status": 1,
            "addtime": "2026-06-22 12:00:00",
            "endtime": "2026-06-22 12:05:00"
        },
        {
            "trade_no": "202606221234567891",
            "out_trade_no": "ORDER_123457",
            "type": "wxpay",
            "pid": "1001",
            "name": "商品名称2",
            "money": "20.00",
            "status": 0,
            "addtime": "2026-06-22 13:00:00",
            "endtime": ""
        }
    ]
}
```

---

### 3. 商户接口

#### 3.1 查询商户信息

**GET** `/api.php?act=query`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |

**响应:**

```json
{
    "code": 1,
    "pid": "1001",
    "key": "your_api_key",
    "active": 1,                  // 账户状态
    "money": 1000.00,             // 可用余额
    "type": "bank",               // 结算方式
    "account": "6222xxxx",        // 结算账号
    "username": "商户名称",
    "orders": 5000,               // 总订单数
    "orders_today": 50,           // 今日订单数
    "orders_lastday": 120         // 昨日订单数
}
```

---

#### 3.2 查询结算记录

**GET** `/api.php?act=settle`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| limit | int | 否 | 每页数量，默认 10，最大 50 |
| offset | int | 否 | 偏移量，默认 0 |

**响应:**

```json
{
    "code": 1,
    "msg": "查询结算记录成功！",
    "data": [
        {
            "id": "202606221234567890",
            "amount": 500.00,
            "status": 1,              // 0待处理 1已处理 2已拒绝
            "addtime": "2026-06-22 12:00:00",
            "endtime": "2026-06-22 18:00:00"
        }
    ]
}
```

---

### 4. 退款接口

#### 4.1 申请退款

**POST** `/api.php?act=refund`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| trade_no | string | 否 | 平台订单号 (与 out_trade_no 二选一) |
| out_trade_no | string | 否 | 商户订单号 |
| money | decimal | 是 | 退款金额 |

**响应:**

```json
// 成功
{
    "code": 0,
    "msg": "退款成功！退款金额¥10.00",
    "refund_no": "202606221234567890",
    "trade_no": "202606221234567890",
    "money": 10.00
}

// 失败
{
    "code": -1,
    "msg": "订单号不存在"
}
```

---

#### 4.2 查询退款记录

**GET** `/api.php?act=refundquery`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| refund_no | string | 否 | 退款单号 (与 out_trade_no 二选一) |
| out_trade_no | string | 否 | 商户订单号 |

**响应:**

```json
{
    "code": 0,
    "refund_no": "202606221234567890",
    "trade_no": "202606221234567890",
    "out_trade_no": "ORDER_123456",
    "money": 10.00,
    "status": 1,                  // 0处理中 1成功 2失败
    "addtime": "2026-06-22 12:00:00",
    "endtime": "2026-06-22 12:05:00"
}
```

---

### 5. 关闭订单

**POST** `/api.php?act=close`

**请求参数:**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pid | int | 是 | 商户ID |
| key | string | 是 | 商户密钥 |
| trade_no | string | 否 | 平台订单号 (与 out_trade_no 二选一) |
| out_trade_no | string | 否 | 商户订单号 |

**响应:**

```json
{
    "code": 0,
    "msg": "订单关闭成功"
}
```

---

## 异步通知

### 通知机制

1. 支付成功后，系统会向商户提供的 `notify_url` 发送 POST 请求
2. 商户收到通知后必须返回字符串 `success`，否则系统会重复通知
3. 重复通知策略：1分钟、5分钟、30分钟、1小时、6小时，共 5 次

### 通知参数

| 参数名 | 类型 | 说明 |
|--------|------|------|
| pid | int | 商户ID |
| trade_no | string | 平台订单号 |
| out_trade_no | string | 商户订单号 |
| type | string | 支付方式 |
| name | string | 商品名称 |
| money | decimal | 订单金额 |
| param | string | 自定义参数 |
| trade_status | string | 交易状态: TRADE_SUCCESS |
| sign | string | 签名 |
| sign_type | string | 签名类型 |

### 验证签名示例

```javascript
// Node.js 示例
const crypto = require('crypto');

function verifyNotify(params, apiKey) {
    const { sign, sign_type, ...otherParams } = params;
    
    // 生成签名
    const sortedKeys = Object.keys(otherParams).sort();
    let signStr = '';
    for (const key of sortedKeys) {
        if (otherParams[key] !== '' && otherParams[key] !== undefined) {
            signStr += key + '=' + otherParams[key] + '&';
        }
    }
    signStr = signStr.slice(0, -1);
    signStr = apiKey + signStr + apiKey;
    
    const expectedSign = crypto.createHash('md5').update(signStr).digest('hex');
    
    return sign === expectedSign;
}

// 处理通知
app.post('/notify', (req, res) => {
    const params = req.body;
    const isValid = verifyNotify(params, 'your_api_key');
    
    if (isValid && params.trade_status === 'TRADE_SUCCESS') {
        // 处理支付成功逻辑
        // ...
        
        res.send('success');
    } else {
        res.send('fail');
    }
});
```

---

## 错误处理

### 常见错误

| 错误信息 | 原因 | 解决方案 |
|----------|------|----------|
| 商户ID不存在 | pid 错误 | 检查商户ID是否正确 |
| 商户密钥错误 | key 错误 | 检查商户密钥是否正确 |
| 签名错误 | sign 计算错误 | 检查签名算法实现 |
| 订单号已存在 | 重复下单 | 更换订单号 |
| 金额不合法 | money 格式错误 | 检查金额格式 |
| 通知地址格式错误 | notify_url 格式错误 | 检查 URL 格式 |
| 商户已被封禁 | 账户状态异常 | 联系管理员 |

---

## SDK

### PHP SDK

```php
<?php
require_once 'EpaySDK.php';

$sdk = new EpaySDK([
    'pid' => '1001',
    'key' => 'your_api_key',
    'api_url' => 'https://your-domain.com'
]);

// 发起支付
$result = $sdk->pay([
    'type' => 'alipay',
    'out_trade_no' => 'ORDER_' . time(),
    'notify_url' => 'https://your-site.com/notify',
    'return_url' => 'https://your-site.com/return',
    'name' => '商品名称',
    'money' => '10.00'
]);

// 查询订单
$order = $sdk->query([
    'trade_no' => '202606221234567890'
]);

// 退款
$refund = $sdk->refund([
    'trade_no' => '202606221234567890',
    'money' => '10.00'
]);
```

### Python SDK

```python
from epay_sdk import EpaySDK

sdk = EpaySDK(
    pid='1001',
    key='your_api_key',
    api_url='https://your-domain.com'
)

# 发起支付
result = sdk.pay(
    type='alipay',
    out_trade_no='ORDER_123456',
    notify_url='https://your-site.com/notify',
    return_url='https://your-site.com/return',
    name='商品名称',
    money='10.00'
)

# 查询订单
order = sdk.query(trade_no='202606221234567890')

# 退款
refund = sdk.refund(
    trade_no='202606221234567890',
    money='10.00'
)
```

### Java SDK

```java
EpaySDK sdk = new EpaySDK.Builder()
    .pid("1001")
    .key("your_api_key")
    .apiUrl("https://your-domain.com")
    .build();

// 发起支付
PayResult result = sdk.pay()
    .type("alipay")
    .outTradeNo("ORDER_" + System.currentTimeMillis())
    .notifyUrl("https://your-site.com/notify")
    .returnUrl("https://your-site.com/return")
    .name("商品名称")
    .money("10.00")
    .execute();

// 查询订单
OrderResult order = sdk.query()
    .tradeNo("202606221234567890")
    .execute();

// 退款
RefundResult refund = sdk.refund()
    .tradeNo("202606221234567890")
    .money("10.00")
    .execute();
```

---

## 测试环境

### 测试商户信息

| 项目 | 值 |
|------|-----|
| 商户ID | 1001 |
| 商户密钥 | test_api_key |
| API地址 | https://sandbox.teaven-pay.com |

### 测试银行卡号

| 银行 | 卡号 |
|------|------|
| 工商银行 | 6222 0200 0000 0001 |
| 建设银行 | 6227 0000 0000 0001 |
| 支付宝 | test@alipay.com |
| 微信 | test_wx_openid |

### 测试流程

1. 使用测试商户信息发起支付
2. 选择支付方式，获取支付链接
3. 使用测试账号完成支付
4. 验证异步通知是否正确接收
5. 查询订单状态是否更新

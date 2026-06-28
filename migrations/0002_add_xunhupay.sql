-- 添加虎皮椒支付方式
INSERT OR IGNORE INTO payment_types (id, name, display_name, icon, sort_order, status) VALUES 
    ('pt_xunhupay', 'xunhupay', '虎皮椒', '/icons/xunhupay.svg', 6, 1);
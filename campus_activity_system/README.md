# 校园活动管理系统 V1.0

## 功能范围

- 学生/教师注册、登录与角色权限
- 学生活动浏览、报名和报名结果查询
- 教师发布、查看、取消活动及查看报名名单
- 重复、满额、截止、取消活动报名校验

不包含支付、通知、评论、收藏、签到和审批等非核心功能。

## 运行

```powershell
python -m pip install -r requirements.txt
python app.py
```

访问 `http://127.0.0.1:5000`。先注册教师账号发布活动，再注册学生账号报名。

## 测试

```powershell
python -m unittest discover -s tests -v
```

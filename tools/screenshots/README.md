# README 截图工具

该目录存放文档截图处理工具，与部署脚本和应用运行代码分离。

## 裁剪移动端系统区域

使用明确的像素值裁掉顶部系统状态栏和底部导航区域：

```bash
npm run screenshot:crop -- \
  --input ../screenshot/example.jpg \
  --output docs/images/example.png \
  --top 108 \
  --bottom 62
```

脚本保持图片原始宽度，将剩余内容输出为 PNG，并移除输入图片携带的 EXIF 等元数据。输出路径不得与输入路径相同。

不同设备的系统栏高度可能不同。正式处理前应先查看原图，分别确认 `--top` 和 `--bottom`，不要直接套用示例值。

### 当前安卓截图建议值

对于本项目现有的 `1200 × 2670` 安卓截图，逐行检查确认的边界为：

- `--top 140`：移除顶部系统状态区域，保留完整的 BugPaw 导航栏。
- `--bottom 52`：移除底部系统手势区域，保留应用页脚内容。

建议命令：

```bash
npm run screenshot:crop -- \
  --input ../screenshot/example_1200_2670.jpg \
  --output ../screenshot/processed/example.png \
  --top 140 \
  --bottom 52
```

该建议值仅适用于同一设备和分辨率生成的这组截图。更换设备、系统显示缩放或截图分辨率后，应重新检查边界。

运行自动化测试：

```bash
node --test tools/screenshots/crop.test.mjs
```

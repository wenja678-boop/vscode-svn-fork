(function() {
    const vscode = acquireVsCodeApi();
    
    // 状态管理
    class UIState {
        constructor() {
            const previousState = vscode.getState() || {
                selectedFiles: [],
                enabledTypes: ['modified', 'added', 'deleted', 'unversioned', 'missing'],
                selectedExtensions: []
            };
            
            this.selectedFiles = new Set(previousState.selectedFiles);
            this.enabledTypes = new Set(previousState.enabledTypes);
            this.selectedExtensions = new Set(previousState.selectedExtensions);
            this.allExtensions = new Set();
            this.isGeneratingAI = false;
        }
        
        save() {
            vscode.setState({
                selectedFiles: Array.from(this.selectedFiles),
                enabledTypes: Array.from(this.enabledTypes),
                selectedExtensions: Array.from(this.selectedExtensions)
            });
        }
        
        toggleFileType(type) {
            if (this.enabledTypes.has(type)) {
                this.enabledTypes.delete(type);
            } else {
                this.enabledTypes.add(type);
            }
            this.save();
            this.updateUI();
        }
        
        toggleExtension(ext) {
            if (this.selectedExtensions.has(ext)) {
                this.selectedExtensions.delete(ext);
            } else {
                this.selectedExtensions.add(ext);
            }
            this.save();
            this.updateUI();
        }
        
        toggleFile(filePath) {
            if (this.selectedFiles.has(filePath)) {
                this.selectedFiles.delete(filePath);
            } else {
                this.selectedFiles.add(filePath);
            }
            this.save();
            this.updateSelectedCount();
            this.updateSelectAllCheckbox();
        }
        
        selectAllVisible() {
            const visibleFiles = this.getVisibleFiles();
            visibleFiles.forEach(path => this.selectedFiles.add(path));
            this.save();
            this.updateUI();
        }
        
        deselectAllVisible() {
            const visibleFiles = this.getVisibleFiles();
            visibleFiles.forEach(path => this.selectedFiles.delete(path));
            this.save();
            this.updateUI();
        }
        
        getVisibleFiles() {
            return Array.from(document.querySelectorAll('.file-item'))
                .filter(item => item.style.display !== 'none')
                .map(item => item.getAttribute('data-path'));
        }
        
        updateUI() {
            this.updateFileList();
            this.updateCheckboxes();
            this.updateFilterChips();
            this.updateExtensionDropdown();
            this.updateSelectedCount();
            this.updateSelectAllCheckbox();
        }
        
        updateFileList() {
            const fileItems = document.querySelectorAll('.file-item');
            let visibleCount = 0;
            
            fileItems.forEach(item => {
                const type = item.getAttribute('data-type');
                const fileName = item.querySelector('.file-name').textContent;
                const ext = this.extractExtension(fileName);
                
                const typeMatch = this.enabledTypes.has(type);
                const extensionMatch = this.selectedExtensions.size === 0 || this.selectedExtensions.has(ext);
                
                if (typeMatch && extensionMatch) {
                    item.style.display = '';
                    visibleCount++;
                } else {
                    item.style.display = 'none';
                    const filePath = item.getAttribute('data-path');
                    if (this.selectedFiles.has(filePath)) {
                        this.selectedFiles.delete(filePath);
                    }
                }
            });
        }
        
        updateCheckboxes() {
            document.querySelectorAll('.file-item').forEach(item => {
                const filePath = item.getAttribute('data-path');
                const checkbox = item.querySelector('.file-checkbox input');
                if (checkbox) {
                    checkbox.checked = this.selectedFiles.has(filePath);
                }
            });
        }
        
        updateFilterChips() {
            document.querySelectorAll('.filter-chip').forEach(chip => {
                const checkbox = chip.querySelector('input[type="checkbox"]');
                const type = checkbox.id.replace('-checkbox', '');
                
                checkbox.checked = this.enabledTypes.has(type);
                chip.classList.toggle('active', this.enabledTypes.has(type));
            });
        }
        
        updateExtensionDropdown() {
            const dropdown = document.getElementById('extensionDropdown');
            const options = document.getElementById('extensionOptions');
            const text = document.getElementById('extensionText');
            
            if (!dropdown || !options || !text) return;
            
            // 更新显示文本
            if (this.selectedExtensions.size === 0) {
                text.textContent = '所有类型';
            } else if (this.selectedExtensions.size === 1) {
                text.textContent = Array.from(this.selectedExtensions)[0];
            } else {
                text.textContent = `已选择 ${this.selectedExtensions.size} 种类型`;
            }
            
            // 更新选项
            options.innerHTML = '';
            
            // 添加"全部"选项
            const allOption = document.createElement('div');
            allOption.className = 'extension-option';
            allOption.innerHTML = `
                <input type="checkbox" ${this.selectedExtensions.size === 0 ? 'checked' : ''}>
                <span>所有类型</span>
            `;
            allOption.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedExtensions.clear();
                this.save();
                this.updateUI();
            });
            options.appendChild(allOption);
            
            // 添加各个扩展名选项
            Array.from(this.allExtensions).sort().forEach(ext => {
                const option = document.createElement('div');
                option.className = 'extension-option';
                option.innerHTML = `
                    <input type="checkbox" ${this.selectedExtensions.has(ext) ? 'checked' : ''}>
                    <span>${ext}</span>
                `;
                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleExtension(ext);
                });
                options.appendChild(option);
            });
        }
        
        updateSelectedCount() {
            const countElement = document.getElementById('selectedCount');
            if (countElement) {
                const count = this.selectedFiles.size;
                countElement.textContent = `已选择 ${count} 个文件`;
            }
        }
        
        updateSelectAllCheckbox() {
            const selectAllCheckbox = document.getElementById('selectAll');
            if (!selectAllCheckbox) return;
            
            const visibleFiles = this.getVisibleFiles();
            const allChecked = visibleFiles.length > 0 && 
                visibleFiles.every(path => this.selectedFiles.has(path));
            
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.disabled = visibleFiles.length === 0;
        }
        
        extractExtension(fileName) {
            return fileName.includes('.') ? 
                '.' + fileName.split('.').pop().toLowerCase() : 
                '(无后缀)';
        }
        
        collectExtensions() {
            this.allExtensions.clear();
            document.querySelectorAll('.file-item').forEach(item => {
                const fileName = item.querySelector('.file-name').textContent;
                const ext = this.extractExtension(fileName);
                this.allExtensions.add(ext);
            });
        }
    }
    
    // 全局状态实例
    const state = new UIState();
    
    // 初始化事件监听器
    function initializeEventListeners() {
        // 文件类型筛选
        document.querySelectorAll('.filter-chip input[type="checkbox"]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                const type = e.target.id.replace('-checkbox', '');
                state.toggleFileType(type);
            });
        });
        
        // 文件类型筛选芯片点击
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    const checkbox = chip.querySelector('input[type="checkbox"]');
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
        });
        
        // 扩展名下拉框
        const extensionDropdown = document.getElementById('extensionDropdown');
        const extensionOptions = document.getElementById('extensionOptions');
        
        if (extensionDropdown && extensionOptions) {
            extensionDropdown.addEventListener('click', () => {
                const isVisible = extensionOptions.style.display === 'block';
                extensionOptions.style.display = isVisible ? 'none' : 'block';
            });
            
            // 点击外部关闭下拉框
            document.addEventListener('click', (e) => {
                if (!extensionDropdown.contains(e.target) && !extensionOptions.contains(e.target)) {
                    extensionOptions.style.display = 'none';
                }
            });
        }
        
        // 全选复选框
        const selectAllCheckbox = document.getElementById('selectAll');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    state.selectAllVisible();
                } else {
                    state.deselectAllVisible();
                }
            });
        }
        
        // 前缀相关
        const prefixSelect = document.getElementById('prefixSelect');
        const prefixInput = document.getElementById('prefixInput');
        const applyPrefixButton = document.getElementById('applyPrefixButton');
        
        if (prefixSelect) {
            prefixSelect.addEventListener('change', () => {
                if (prefixInput && prefixSelect.value) {
                    prefixInput.value = prefixSelect.value;
                }
            });
        }
        
        if (applyPrefixButton) {
            applyPrefixButton.addEventListener('click', applyPrefix);
        }
        
        // 提交按钮
        const submitButton = document.getElementById('submitButton');
        const generateAIButton = document.getElementById('generateAIButton');
        
        if (submitButton) {
            submitButton.addEventListener('click', submitCommit);
        }
        
        if (generateAIButton) {
            generateAIButton.addEventListener('click', generateAILog);
        }
    }
    
    // 初始化文件项事件
    function initializeFileItemEvents() {
        document.querySelectorAll('.file-item').forEach(item => {
            const checkbox = item.querySelector('.file-checkbox input');
            const filePath = item.getAttribute('data-path');
            
            // 复选框事件
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    e.stopPropagation();
                    state.toggleFile(filePath);
                });
            }
            
            // 文件项点击事件（切换选中状态）
            item.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox' && !e.target.closest('button')) {
                    state.toggleFile(filePath);
                    if (checkbox) {
                        checkbox.checked = state.selectedFiles.has(filePath);
                    }
                }
            });
            
            // 操作按钮事件
            const diffButton = item.querySelector('.action-btn[title*="差异"]');
            const openButton = item.querySelector('.action-btn[title*="打开"], .action-btn[title*="对比"]');
            const revertButton = item.querySelector('.action-btn.danger');
            
            if (diffButton) {
                diffButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showDiff(filePath);
                });
            }
            
            if (openButton) {
                openButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showSideBySideDiff(filePath);
                });
            }
            
            if (revertButton) {
                revertButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    revertFile(filePath);
                });
            }
        });
    }
    
    // 业务逻辑函数
    function showDiff(filePath) {
        vscode.postMessage({ command: 'showDiff', file: filePath });
    }
    
    function showSideBySideDiff(filePath) {
        vscode.postMessage({ command: 'showSideBySideDiff', file: filePath });
    }
    
    function revertFile(filePath) {
        vscode.postMessage({ command: 'revertFile', file: filePath });
    }
    
    function submitCommit() {
        const messageElement = document.getElementById('commitMessage');
        const message = messageElement ? messageElement.value.trim() : '';
        
        if (!message) {
            vscode.postMessage({ 
                command: 'showError',
                text: '请输入提交信息'
            });
            return;
        }
        
        const selectedFilesList = Array.from(state.selectedFiles);
        if (selectedFilesList.length === 0) {
            vscode.postMessage({
                command: 'showError',
                text: '请选择要提交的文件'
            });
            return;
        }
        
        vscode.postMessage({
            command: 'commit',
            message: message,
            files: selectedFilesList
        });
    }
    
    function generateAILog() {
        if (state.isGeneratingAI) return;
        
        const selectedFilesList = Array.from(state.selectedFiles);
        if (selectedFilesList.length === 0) {
            vscode.postMessage({
                command: 'showError',
                text: '请选择要生成提交日志的文件'
            });
            return;
        }
        
        vscode.postMessage({ command: 'generateAILog' });
    }
    
    function applyPrefix() {
        const prefixInput = document.getElementById('prefixInput');
        const commitMessage = document.getElementById('commitMessage');
        
        if (!prefixInput || !commitMessage) return;
        
        const prefix = prefixInput.value.trim();
        if (prefix) {
            vscode.postMessage({
                command: 'savePrefix',
                prefix: prefix
            });
            
            const currentMessage = commitMessage.value.trim();
            const lines = currentMessage.split('\n');
            const newMessage = prefix + '\n' + (lines.length > 1 ? lines.slice(1).join('\n') : currentMessage);
            
            commitMessage.value = newMessage;
        }
    }
    
    // 消息监听
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'setCommitMessage':
                const commitMessage = document.getElementById('commitMessage');
                if (commitMessage) {
                    commitMessage.value = message.message;
                }
                break;
                
            case 'getSelectedFiles':
                vscode.postMessage({
                    command: 'selectedFiles',
                    files: Array.from(state.selectedFiles)
                });
                break;
                
            case 'getCurrentPrefix':
                const prefixInput = document.getElementById('prefixInput');
                vscode.postMessage({
                    command: 'currentPrefix',
                    prefix: prefixInput ? prefixInput.value.trim() : ''
                });
                break;
                
            case 'setGeneratingStatus':
                const aiButton = document.getElementById('generateAIButton');
                const aiButtonText = document.getElementById('aiButtonText');
                
                state.isGeneratingAI = message.status;
                
                if (aiButton) {
                    aiButton.disabled = message.status;
                }
                
                if (aiButtonText) {
                    aiButtonText.textContent = message.status ? 
                        '🔄 生成中...' : 
                        '🤖 AI生成提交日志';
                }
                break;
        }
    });
    
    // 页面加载完成后初始化
    document.addEventListener('DOMContentLoaded', () => {
        state.collectExtensions();
        initializeEventListeners();
        initializeFileItemEvents();
        state.updateUI();
        
        // 添加一些增强的交互效果
        addEnhancedInteractions();
    });
    
    // 增强的交互效果
    function addEnhancedInteractions() {
        // 为文件项添加选中状态的视觉反馈
        document.querySelectorAll('.file-item').forEach(item => {
            const filePath = item.getAttribute('data-path');
            
            // 更新选中状态的视觉效果
            const updateSelectedState = () => {
                item.classList.toggle('selected', state.selectedFiles.has(filePath));
            };
            
            // 初始状态
            updateSelectedState();
            
            // 监听状态变化
            const observer = new MutationObserver(() => {
                updateSelectedState();
            });
            
            observer.observe(item.querySelector('.file-checkbox input'), {
                attributes: true,
                attributeFilter: ['checked']
            });
        });
        
        // 添加键盘快捷键支持
        document.addEventListener('keydown', (e) => {
            // Ctrl+A 全选
            if (e.ctrlKey && e.key === 'a') {
                e.preventDefault();
                const selectAllCheckbox = document.getElementById('selectAll');
                if (selectAllCheckbox && !selectAllCheckbox.disabled) {
                    selectAllCheckbox.checked = true;
                    selectAllCheckbox.dispatchEvent(new Event('change'));
                }
            }
            
            // Escape 取消选择
            if (e.key === 'Escape') {
                const selectAllCheckbox = document.getElementById('selectAll');
                if (selectAllCheckbox) {
                    selectAllCheckbox.checked = false;
                    selectAllCheckbox.dispatchEvent(new Event('change'));
                }
            }
        });
        
        // 添加拖拽选择支持（可选）
        let isDragging = false;
        let startElement = null;
        
        document.addEventListener('mousedown', (e) => {
            if (e.target.closest('.file-item') && !e.target.closest('button') && e.target.type !== 'checkbox') {
                isDragging = true;
                startElement = e.target.closest('.file-item');
            }
        });
        
        document.addEventListener('mousemove', (e) => {
            if (isDragging && e.target.closest('.file-item')) {
                const currentElement = e.target.closest('.file-item');
                if (currentElement !== startElement) {
                    // 可以在这里实现范围选择逻辑
                }
            }
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
            startElement = null;
        });
    }
})(); 